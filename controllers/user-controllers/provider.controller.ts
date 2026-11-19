import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { validationResult } from "express-validator";
import { googleCloudStorage, providerAccountBucket } from "../service-accounts/cloud-storage";
import stripe from "../service-accounts/stripe";

import UserModel from "../../dal/models/user.model";
import ProviderAccountRequest from "../../dal/models/providerapplication.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import {
	generateAccountLink,
	sendBookingAcceptedNotification,
	sendBookingStartedNotification,
} from "./utils/provider.utils";
import { isValidObjectId, withDisplayStatus } from "./utils/booking.utils";
import { COUNTERPARTY_SELECT, withCounterparties } from "./utils/counterparty.utils";
import { serializePayment } from "./utils/payment.utils";
import PayoutModel from "../../dal/models/payout.model";
import { sendCometChatMessage } from "./utils/cometchat.util";
import { publicValidationErrors } from "../../middleware/sanitizeInput";
import { storedFileInfo } from "../../middleware/uploads";
import { emitEvent } from "../../lib/events";
import log from "../../lib/logger";

const APPLICATION_FIELDS = ["firstName", "lastName", "email", "phone", "country", "state", "city", "street"] as const;
const JOB_TYPE_KEYS = ["publicAreaAttendant", "roomAttendant", "linenPorter"] as const;

/** Job types from the mobile app's JSON field or the web app's three separate fields; booleans only. */
const parseJobTypes = (body: Record<string, unknown>) => {
	let source: Record<string, unknown> = {};
	if (typeof body.jobTypes === "string") {
		try {
			const parsed = JSON.parse(body.jobTypes);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) source = parsed;
		} catch {
			source = {};
		}
	} else {
		source = body;
	}
	const isTrue = (value: unknown) => value === true || value === "true";
	return Object.fromEntries(JOB_TYPE_KEYS.map((key) => [key, isTrue(source[key])])) as Record<
		(typeof JOB_TYPE_KEYS)[number],
		boolean
	>;
};

declare module "express" {
	interface Request {
		user?: string;
		roles?: { User: boolean; Provider: boolean };
		bookingId?: string;
	}
}

export const handleRequestProviderAccount = async (req: Request, res: Response) => {
	const errors = validationResult(req);
	if (!errors.isEmpty()) {
		return res.status(400).json({
			message: "Invalid Request.",
			errors: publicValidationErrors(errors),
		});
	}

	try {
		const userEmail = req.user;
		const user = await UserModel.findOne({ email: userEmail }).populate("providerApplications");
		if (!user) {
			throw new Error("User not found.");
		}

		// Check if there is any pending or approved request
		const hasPendingOrApprovedRequest = user.providerApplications.some(
			(request: any) => request.status === "pending" || request.status === "approved",
		);

		if (hasPendingOrApprovedRequest) {
			return res.status(400).json({
				message: "You already have a pending or approved provider account request.",
			});
		}

		const requestId = uuidv4();
		const files = req.files as { [fieldname: string]: Express.Multer.File[] };
		const jobTypes = parseJobTypes(req.body);

		// Identity documents go to the private applications bucket; admins read them through short-lived signed URLs.
		// The stored name uses only the field name and an allow-listed extension, and is never shown to clients.
		const filePaths: { [key: string]: string } = {};
		for (const field of ["id", "dbs", "resume", "profile"]) {
			const file = files?.[field]?.[0];
			if (!file) continue;
			const { extension, contentType } = storedFileInfo(field, file);
			const filePath = `${requestId}/${field}.${extension}`;
			await googleCloudStorage
				.bucket(providerAccountBucket)
				.file(filePath)
				.save(file.buffer, { contentType, resumable: false });
			filePaths[field] = filePath;
		}

		// Only the application fields are taken from the request; status, review fields and ids are the server's.
		const fields = Object.fromEntries(APPLICATION_FIELDS.map((key) => [key, req.body[key]]));
		const providerAccountRequest = new ProviderAccountRequest({
			...fields,
			...filePaths,
			status: "pending",
			jobTypes,
		});

		await providerAccountRequest.save();

		user.providerApplications.push(providerAccountRequest._id as any);
		user.providerStatus = "pending";
		await user.save();
		emitEvent(
			{
				type: "provider.application_submitted",
				actor: { type: "provider", id: user._id },
				subjects: { userId: user._id, providerId: user._id, applicationId: providerAccountRequest._id },
				properties: { jobTypes },
			},
			req,
		);

		res.status(200).json({ message: "Files uploaded successfully." });
	} catch (error) {
		log.error("Error handling file upload", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleUpdateProviderAvailability = async (req: Request, res: Response) => {
	const errors = validationResult(req);
	if (!errors.isEmpty()) {
		return res.status(400).json({ message: errors.array()[0].msg });
	}
	try {
		const { isProviderAvailable, currentLocation, selectedJobTypes } = req.body;
		const update: Record<string, unknown> = { isProviderAvailable };
		if (currentLocation) {
			update.currentLocation = currentLocation;
			update.locationUpdatedAt = new Date();
		}
		if (selectedJobTypes) update.selectedJobTypes = selectedJobTypes.map((id: number) => ({ id: Number(id) }));

		const previous = await UserModel.findOneAndUpdate({ email: req.user }, { $set: update }, { new: false }).exec();
		if (!previous) {
			return res.status(404).json({ message: "User not found." });
		}
		const user = await UserModel.findById(previous._id).exec();
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}
		if (previous.isProviderAvailable !== user.isProviderAvailable) {
			emitEvent(
				{
					type: "provider.availability_changed",
					actor: { type: "provider", id: user._id },
					subjects: { providerId: user._id },
					properties: {
						available: user.isProviderAvailable,
						via: "http",
						...(selectedJobTypes ? { jobTypes: user.selectedJobTypes.map((job) => job.id) } : {}),
					},
				},
				req,
			);
		}
		res.status(200).json({
			isProviderAvailable: user.isProviderAvailable,
			currentLocation: user.currentLocation,
			selectedJobTypes: user.selectedJobTypes.map((job) => job.id),
		});
	} catch (error) {
		log.error("Error updating provider availability", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};

export const handleAccountApprovalScreen = async (req: Request, res: Response) => {
	try {
		const userEmail = req.user;
		const user = await UserModel.findOne({ email: userEmail });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}
		user.providerAccountApproval = true;
		await user?.save();
		res.status(200).json({ message: "Account approval screen set." });
	} catch (error) {
		log.error("Error approving account", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleGetBookings = async (req: Request, res: Response) => {
	try {
		const bookings = await BookingModel.find({
			status: "pending",
			providerId: null,
		})
			.populate("userId", COUNTERPARTY_SELECT)
			.exec();
		const bookingIds = bookings.map((booking) => booking._id);
		const payments = await PaymentModel.find({ bookingId: { $in: bookingIds }, status: "completed" });
		const paidBookingIds = payments.map((payment) => payment.bookingId.toString());
		const paidBookings = bookings
			.filter((booking: any) => {
				const isPaid = paidBookingIds.includes(booking._id.toString());
				if (!isPaid) return false;

				const now = new Date();
				const bookingStartDate = new Date(booking.startDate);

				const bookingStartDateTime = new Date(
					bookingStartDate.getFullYear(),
					bookingStartDate.getMonth(),
					bookingStartDate.getDate(),
					bookingStartDate.getHours(),
					bookingStartDate.getMinutes(),
				);

				// Check if the booking start time is at least 10 minutes from now
				return bookingStartDateTime.getTime() >= now.getTime() + 10 * 60 * 1000;
			})
			.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

		res.status(200).json({
			paidBookings: paidBookings.map((booking) => withCounterparties(withDisplayStatus(booking))),
		});
	} catch (error) {
		log.error("Error getting bookings", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleGetBookingById = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.body;
		if (!bookingId) {
			return res.status(400).json({ message: "No booking id provided." });
		}
		if (!isValidObjectId(bookingId)) {
			return res.status(400).json({ message: "Invalid booking id." });
		}

		const user = await UserModel.findOne({ email: req.user });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const booking = await BookingModel.findById(bookingId).populate("userId", COUNTERPARTY_SELECT).exec();
		if (!booking) {
			return res.status(404).json({ message: "Booking not found." });
		}

		const isAssignedProvider = booking.providerId?.toString() === (user._id as any).toString();
		const isOpenForAcceptance = booking.status === "pending" && !booking.providerId;
		if (!isAssignedProvider && booking.status === "pending" && booking.providerId) {
			return res.status(409).json({ message: "This order was already accepted by another provider." });
		}
		if (!isAssignedProvider && !isOpenForAcceptance) {
			return res.status(403).json({ message: "User not authorized to view this booking." });
		}

		const payment = await PaymentModel.findOne({ bookingId }).exec();
		if (!payment) {
			return res.status(404).json({ message: "Payment details not found for this booking." });
		}

		// The client secret lets its holder act on the customer's payment intent; providers never use it.
		res.status(200).json({
			booking: withCounterparties(withDisplayStatus(booking)),
			payment: serializePayment(payment, { includeClientSecret: false }),
		});
	} catch (error) {
		log.error("Error getting booking by id", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleAcceptBooking = async (req: Request, res: Response) => {
	try {
		const userEmail = req.user;
		if (!userEmail) {
			return res.status(400).json({ message: "User email is required." });
		}

		const user = await UserModel.findOne({ email: userEmail });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const { bookingId } = req.body;
		if (!bookingId) {
			return res.status(400).json({ message: "Booking ID is required." });
		}

		if (!isValidObjectId(bookingId)) {
			return res.status(400).json({ message: "Invalid booking id." });
		}

		const booking = await BookingModel.findById(bookingId);
		if (!booking || booking.status !== "pending") {
			return res.status(404).json({ message: "Booking not found or not pending." });
		}

		if (booking.providerId) {
			return res.status(409).json({ message: "Booking has already been accepted by another provider." });
		}

		const payment = await PaymentModel.findOne({ bookingId: bookingId, status: "completed" });
		if (!payment) {
			return res.status(400).json({ message: "Payment not completed for this booking." });
		}

		const now = new Date();
		const bookingStartDateTime = new Date(
			booking.startDate.getFullYear(),
			booking.startDate.getMonth(),
			booking.startDate.getDate(),
			booking.startDate.getHours(),
			booking.startDate.getMinutes(),
		);

		if (bookingStartDateTime.getTime() < now.getTime()) {
			return res.status(400).json({ message: "Booking start time has already passed." });
		}

		if (user.stripeConnectedAccountId === null) {
			return res.status(400).json({ message: "Please connect your stripe account first." });
		}

		// Only one provider can win: the update matches only while the booking is still unassigned.
		const acceptedAt = new Date();
		const accepted = await BookingModel.findOneAndUpdate(
			{ _id: booking._id, status: "pending", providerId: null },
			{ $set: { providerId: user._id, acceptedAt } },
			{ new: true },
		).exec();
		if (!accepted) {
			return res.status(409).json({ message: "Booking has already been accepted by another provider." });
		}
		emitEvent(
			{
				type: "booking.accepted",
				actor: { type: "provider", id: user._id },
				subjects: { userId: accepted.userId, providerId: user._id, bookingId: accepted._id },
				properties: {
					timeToAcceptMs: acceptedAt.getTime() - new Date(accepted.createdAt).getTime(),
					untilStartMs: accepted.startDate.getTime() - acceptedAt.getTime(),
				},
			},
			req,
		);

		await sendBookingAcceptedNotification(booking.userId.toString(), user.firstName, accepted);
		await sendCometChatMessage(booking.userId.toString(), String(user._id));

		res.status(200).json({ message: "Booking accepted successfully." });
	} catch (error) {
		log.error("Error accepting booking", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleMyOrders = async (req: Request, res: Response) => {
	try {
		const userEmail = req.user;
		if (!userEmail) {
			return res.status(400).json({ message: "User email is required." });
		}

		const user = await UserModel.findOne({ email: userEmail });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const bookings = await BookingModel.find({ providerId: user._id }).sort({ startDate: 1 });
		res.status(200).json(bookings.map(withDisplayStatus));
	} catch (error) {
		log.error("Error accepting booking", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleStartBooking = async (req: Request, res: Response) => {
	try {
		const userEmail = req.user;
		const { bookingId } = req.body;
		if (!userEmail || !bookingId) {
			return res.status(400).json({ message: "User email and booking id is required." });
		}

		if (!isValidObjectId(bookingId)) {
			return res.status(400).json({ message: "Invalid booking id." });
		}

		const user = await UserModel.findOne({ email: userEmail });
		const booking = await BookingModel.findById(bookingId);

		if (!user || !booking) {
			return res.status(404).json({ message: "User or booking not found." });
		}

		// REQUIRES ATTENTION
		// if (booking.startDate.getTime() > new Date().getTime()) {
		// 	return res.status(400).json({ message: "Booking start time is not yet reached." });
		// }

		if (booking.providerId?.toString() != user._id?.toString()) {
			return res.status(400).json({ message: "This is not the provider for this booking." });
		}

		if (booking.status !== "pending") {
			return res.status(400).json({ message: "Only an accepted booking that has not started can be started." });
		}

		const requestedAt = new Date();
		booking.userApprovalRequested = true;
		booking.startRequestedAt = requestedAt;
		await booking.save();
		emitEvent(
			{
				type: "booking.start_requested",
				actor: { type: "provider", id: user._id },
				subjects: { userId: booking.userId, providerId: user._id, bookingId: booking._id },
				properties: { offsetFromStartMs: requestedAt.getTime() - booking.startDate.getTime() },
			},
			req,
		);

		await sendBookingStartedNotification(booking.userId.toString(), booking);

		res.status(200).json({ message: "Booking started successfully." });
	} catch (error) {
		log.error("Error starting booking", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleGetStripeConnectedAccount = async (req: Request, res: Response) => {
	const email = req.user;

	try {
		const user = await UserModel.findOne({ email: email }).select("stripeConnectedAccountId").lean();
		if (!user) {
			return res.status(404).json({ message: "User not found" });
		}

		let connectedAccountId = user.stripeConnectedAccountId;

		if (!connectedAccountId) {
			const account = await stripe.accounts.create({
				type: "express",
				email: email,
				settings: {
					payouts: {
						schedule: {
							interval: "manual",
						},
					},
				},
			});

			// Store it only if no other request stored one meanwhile, so the user keeps a single account.
			const stored = await UserModel.findOneAndUpdate(
				{ email: email, stripeConnectedAccountId: { $in: ["", null] } },
				{ $set: { stripeConnectedAccountId: account.id } },
				{ new: true },
			).exec();
			connectedAccountId =
				stored?.stripeConnectedAccountId ??
				(await UserModel.findOne({ email }).select("stripeConnectedAccountId").lean())
					?.stripeConnectedAccountId ??
				account.id;
		}

		const connectedAccountOnboardingLink = await generateAccountLink(connectedAccountId);

		return res.status(200).json({ connectedAccountOnboardingLink });
	} catch (error) {
		log.error("Error handling Stripe connected account", error);
		return res.status(500).json({ message: "Internal server error" });
	}
};

export const handleGetEarnings = async (req: Request, res: Response) => {
	const email = req.user;

	try {
		const user = await UserModel.findOne({ email: email });
		if (!user) {
			return res.status(404).json({ message: "User not found" });
		}

		const providerBookings = await BookingModel.find({
			providerId: user._id,
			status: "completed",
		});

		const earnings = await EarningModel.find({
			bookingId: { $in: providerBookings.map((booking) => booking._id) },
		}).sort({ createdAt: -1 });

		const payouts = await PayoutModel.find({ userId: user._id }).sort({ createdAt: -1 });

		const availableBalance = user.availableBalance || 0;
		return res.status(200).json({ availableBalance, earnings, payouts });
	} catch (error) {
		log.error("Error getting provider earnings", error);
		return res.status(500).json({ message: "Internal server error" });
	}
};

export const handleCreatePayout = async (req: Request, res: Response) => {
	const email = req.user;
	const amount = req.body.amount;

	if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 20) {
		return res.status(400).json({ message: "Valid amount is required." });
	}

	let reservedFor: unknown = null;
	try {
		const user = await UserModel.findOne({ email });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		if (!user.stripeConnectedAccountId) {
			return res.status(400).json({ message: "User does not have a Stripe connected account." });
		}

		const externalAccounts = await stripe.accounts.listExternalAccounts(user.stripeConnectedAccountId);
		if (!externalAccounts.data.length) {
			return res
				.status(400)
				.json({ message: "Please add a bank account to your stripe account (External account)" });
		}

		// Take the amount off the balance first, atomically, so two payouts at once cannot both spend it.
		const reserved = await UserModel.updateOne(
			{ _id: user._id, availableBalance: { $gte: amount } },
			{ $inc: { availableBalance: -amount } },
		);
		if (reserved.modifiedCount !== 1) {
			return res.status(400).json({ message: "You have insufficient balance for this payout." });
		}
		reservedFor = user._id;

		const payout = await stripe.payouts.create(
			{
				amount: Math.round(amount * 100),
				currency: "usd",
			},
			{
				stripeAccount: user.stripeConnectedAccountId,
			},
		);
		// From here the money has left; the balance stays reduced even if recording fails below.
		reservedFor = null;

		let destinationInfo: { type: string; last4: string | null; country: string | null; currency: string | null } = {
			type: "unknown",
			last4: null,
			country: null,
			currency: null,
		};
		try {
			const payoutDetails = await stripe.payouts.retrieve(payout.id, {
				stripeAccount: user.stripeConnectedAccountId,
			});
			const destinationDetails =
				payoutDetails.destination && typeof payoutDetails.destination === "string"
					? await stripe.accounts.retrieveExternalAccount(
							user.stripeConnectedAccountId,
							payoutDetails.destination,
						)
					: null;
			if (destinationDetails) {
				destinationInfo = {
					type: destinationDetails.object,
					last4: destinationDetails.last4,
					country: destinationDetails.country || null,
					currency: destinationDetails.currency || null,
				};
			}
		} catch (error) {
			log.error("Error reading payout destination", error);
		}

		const payoutRecord = await PayoutModel.create({
			userId: user._id,
			amount: amount,
			currency: "usd",
			payoutId: payout.id,
			status: payout.status,
			paymentMethod: "stripe",
			destinationAccount: user.stripeConnectedAccountId,
			destinationDetails: destinationInfo,
		});

		emitEvent(
			{
				type: "payout.requested",
				actor: { type: "provider", id: user._id },
				subjects: { providerId: user._id, payoutId: payoutRecord._id },
				properties: { amount, status: payout.status },
			},
			req,
		);

		return res.status(200).json({
			success: true,
			payout: payoutRecord,
		});
	} catch (error: any) {
		log.error("Error creating payout", error);
		if (reservedFor) {
			// Stripe did not create the payout; give the reserved amount back.
			await UserModel.updateOne({ _id: reservedFor }, { $inc: { availableBalance: amount } }).catch((err) =>
				log.error("Error restoring balance after a failed payout", err),
			);
		}

		if (error.type === "StripeInvalidRequestError") {
			return res.status(400).json({ message: "The payout could not be created. Check your Stripe account." });
		}

		return res.status(500).json({ message: "Internal server error" });
	}
};

export const handleGetStripeExpressLoginLink = async (req: Request, res: Response) => {
	const email = req.user;

	try {
		const user = await UserModel.findOne({ email: email });
		if (!user) {
			return res.status(404).json({ message: "User not found" });
		}

		if (!user.stripeConnectedAccountId) {
			return res.status(400).json({ message: "Stripe connected account not found" });
		}

		const account = await stripe.accounts.retrieve(user.stripeConnectedAccountId);
		if (!account.details_submitted) {
			return res.status(400).json({ message: "Account details not submitted" });
		}

		const loginLink = await stripe.accounts.createLoginLink(user.stripeConnectedAccountId);
		return res.status(200).json({ loginLink });
	} catch (error) {
		log.error("Error getting Stripe express login link", error);
		return res.status(500).json({ message: "Internal server error" });
	}
};
