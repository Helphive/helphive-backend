import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { validationResult } from "express-validator";
import { googleStorage, providerAccountBucket } from "../service-accounts/cloud-storage";

import UserModel from "../../dal/models/user.model";
import ProviderAccountRequest from "../../dal/models/providerapplication.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import { sendNotification } from "../service-accounts/onesignal";
import stripe from "../service-accounts/stripe";

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
			await googleStorage.bucket(providerAccountBucket).file(filePath).save(file.buffer);
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
			.filter((booking) => {
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

		booking.providerId = user._id;
		await booking.save();

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

const sendBookingStartedNotification = async (userId: string, bookingId: string) => {
	try {
		const notificationMessage = {
			include_aliases: { external_id: [userId] },
			contents: { en: `Your booking requires attention!` },
			headings: { en: "Please approve the provider's request to start the job." },
			data: {
				screen: "BookingDetails",
				bookingId: bookingId,
			},
		};
		console.log(notificationMessage);

		await sendNotification(notificationMessage);
		console.log("Notification sent to ids: ", userId);
	} catch (error: any) {
		console.error(
			`Error sending booking notification for booking ID ${bookingId} to available providers:`,
			error.response,
		);
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

const generateAccountLink = async (connectedAccountId: string) => {
	const accountLink = await stripe.accountLinks.create({
		account: connectedAccountId,
		refresh_url: "https://yourapp.com/onboarding/refresh", // Ensure this is a valid URL
		return_url: "https://yourapp.com/onboarding-complete", // Use a valid URL here
		type: "account_onboarding",
	});

	return accountLink.url;
};
