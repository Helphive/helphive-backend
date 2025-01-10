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
import { generateAccountLink, sendBookingStartedNotification } from "./utils/provider.utils";
import PayoutModel from "../../dal/models/payout.model";
import { sendCometChatMessage } from "./utils/cometchat.util";

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
			errors: errors.array(),
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
		const jobTypes = req.body.jobTypes ? JSON.parse(req.body.jobTypes) : {};

		async function uploadFile(file: Express.Multer.File, filePath: string): Promise<void> {
			await googleCloudStorage.bucket(providerAccountBucket).file(filePath).save(file.buffer);
		}

		const filePaths: { [key: string]: string } = {};

		for (const fileField in files) {
			const fileArray = files[fileField];
			for (const file of fileArray) {
				const fileType = fileField;
				const filePath = `${requestId}/${fileType}.${file.originalname.split(".").pop()}`;
				await uploadFile(file, filePath);
				filePaths[fileType] = filePath;
			}
		}

		const providerAccountRequest = new ProviderAccountRequest({
			...req.body,
			...filePaths,
			status: "pending",
			jobTypes,
		});

		await providerAccountRequest.save();

		user.providerApplications.push(providerAccountRequest._id as any);
		user.providerStatus = "pending";
		await user.save();

		res.status(200).json({ message: "Files uploaded successfully." });
	} catch (error) {
		console.error("Error handling file upload:", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
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
		console.error("Error approving account:", error);
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
			.populate("userId")
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

		res.status(200).json({ paidBookings });
	} catch (error) {
		console.error("Error getting bookings:", error);
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
		const booking = await BookingModel.findById(bookingId).populate("userId").exec();
		if (!booking) {
			return res.status(404).json({ message: "Booking not found." });
		}

		const payment = await PaymentModel.findOne({ bookingId }).exec();
		if (!payment) {
			return res.status(404).json({ message: "Payment details not found for this booking." });
		}

		res.status(200).json({
			booking,
			payment,
		});
	} catch (error) {
		console.error("Error getting booking by id:", error);
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

		const booking = await BookingModel.findById(bookingId);
		if (!booking || booking.status !== "pending") {
			return res.status(404).json({ message: "Booking not found or not pending." });
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

		booking.providerId = user._id as any;
		await booking.save();

		await sendCometChatMessage(booking.userId.toString(), (user._id as string).toString());

		res.status(200).json({ message: "Booking accepted successfully." });
	} catch (error) {
		console.error("Error accepting booking:", error);
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
		res.status(200).json(bookings);
	} catch (error) {
		console.error("Error accepting booking:", error);
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

		booking.userApprovalRequested = true;
		await booking.save();

		console.log(booking.userId.toString(), bookingId);
		await sendBookingStartedNotification(booking.userId.toString(), bookingId);

		res.status(200).json({ message: "Booking started successfully." });
	} catch (error) {
		console.error("Error starting booking:", error);
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
				email: req.body.email,
				settings: {
					payouts: {
						schedule: {
							interval: "manual",
						},
					},
				},
			});

			connectedAccountId = account.id;
			await UserModel.findOneAndUpdate({ email: email }, { stripeConnectedAccountId: connectedAccountId });
		}

		const connectedAccountOnboardingLink = await generateAccountLink(connectedAccountId);

		return res.status(200).json({ connectedAccountOnboardingLink });
	} catch (error) {
		console.error("Error handling Stripe connected account:", error);
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
		console.error("Error getting provider earnings:", error);
		return res.status(500).json({ message: "Internal server error" });
	}
};

export const handleCreatePayout = async (req: Request, res: Response) => {
	try {
		const email = req.user;
		const amount = req.body.amount;

		if (!amount || isNaN(amount) || amount < 20 || !Number.isInteger(amount)) {
			return res.status(400).json({ message: "Valid amount is required." });
		}

		const user = await UserModel.findOne({ email });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		if (!user.stripeConnectedAccountId) {
			return res.status(400).json({ message: "User does not have a Stripe connected account." });
		}

		if (user.availableBalance < amount) {
			return res.status(400).json({ message: "You have insufficient balance for this payout." });
		}

		const externalAccounts = await stripe.accounts.listExternalAccounts(user.stripeConnectedAccountId);

		if (!externalAccounts.data.length) {
			return res
				.status(400)
				.json({ message: "Please add a bank account to your stripe account (External account)" });
		}

		const payout = await stripe.payouts.create(
			{
				amount: Math.round(amount * 100),
				currency: "usd",
			},
			{
				stripeAccount: user.stripeConnectedAccountId,
			},
		);

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

		const destinationInfo = destinationDetails
			? {
					type: destinationDetails.object,
					last4: destinationDetails.last4,
					country: destinationDetails.country || null,
					currency: destinationDetails.currency || null,
				}
			: { type: "unknown", last4: null, country: null, currency: null };

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

		user.availableBalance -= amount;
		await user.save();

		return res.status(200).json({
			success: true,
			payout: payoutRecord,
		});
	} catch (error: any) {
		console.error("Error creating payout:", error);

		if (error.type === "StripeInvalidRequestError") {
			return res.status(400).json({ message: error.message });
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
		console.error("Error getting Stripe express login link:", error);
		return res.status(500).json({ message: "Internal server error" });
	}
};
