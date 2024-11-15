import { NextFunction, Request, Response } from "express";
import { validationResult } from "express-validator";

import stripe from "../service-accounts/stripe";

import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import { sendNotification } from "../service-accounts/onesignal";

declare module "express" {
	interface Request {
		user?: string;
		roles?: { User: boolean; Provider: boolean };
		bookingId?: string;
	}
}

export const handleCreateBooking = async (req: Request, res: Response, next: NextFunction) => {
	console.log("Handling create booking request...");

	const errors = validationResult(req);
	if (!errors.isEmpty()) {
		console.error("Validation error:", errors.array());
		return res.status(400).json({
			message: "Invalid Request.",
			errors: errors.array(),
		});
	}

	try {
		const { service, rate, startDate, startTime, hours, address, latitude, longitude } = req.body;

		const userEmail = req.user;

		const user = await UserModel.findOne({ email: userEmail });

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		let dateParts = startDate.split("T")[0].split("-");
		if (startDate < startTime) {
			dateParts = startTime.split("T")[0].split("-");
		}
		const timeParts = startTime.split("T")[1].split(".")[0];
		const combinedDateString = `${dateParts[0]}-${dateParts[1]}-${dateParts[2]}T${timeParts}`;

		const combinedDate = new Date(combinedDateString + "Z");

		const now = new Date();
		const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

		if (combinedDate < oneHourFromNow) {
			return res.status(400).json({ message: "Start date and time must be at least 1 hour in the future." });
		}

		const newBooking = new BookingModel({
			status: "pending",
			userId: user._id,
			service: {
				id: service,
			},
			rate: parseInt(rate, 10),
			hours: parseInt(hours, 10),
			startDate: combinedDate,
			address,
			latitude,
			longitude,
			createdAt: new Date(),
		});
		await newBooking.save();

		req.bookingId = newBooking._id;
		next();
	} catch (error) {
		console.error("Error handling create booking:", error);
		res.status(500).json({
			message: "An error occurred while processing the request.",
		});
	}
};

export const handleCreatePaymentIntent = async (req: Request, res: Response) => {
	const { rate, hours } = req.body;

	try {
		const paymentAmount = Number(rate) * Number(hours);
		const paymentIntent = await stripe.paymentIntents.create({
			amount: paymentAmount * 100,
			currency: "usd",
		});

		const newPayment = new PaymentModel({
			bookingId: req.bookingId,
			amount: paymentAmount,
			date: new Date(),
			status: "pending",
			paymentIntentId: paymentIntent.id,
			clientSecret: paymentIntent.client_secret,
		});
		await newPayment.save();

		res.json({
			bookingId: req.bookingId,
			paymentIntentId: paymentIntent.id,
			clientSecret: paymentIntent.client_secret,
		});
	} catch (error) {
		console.error("Error handling create payment intent:", error);
		res.status(500).json({
			message: "An error occurred while processing the request.",
		});
	}
};

export const handleGetUserBookings = async (req: any, res: Response) => {
	try {
		const userEmail = req.user;
		const user = await UserModel.findOne({ email: userEmail });

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const bookings = await BookingModel.find({ userId: user._id });

		const history = [] as any;
		const active = [] as any;
		const scheduled = [] as any;

		await Promise.all(
			bookings.map(async (booking) => {
				// Update booking status if necessary
				if (booking.status === "pending" && !booking.providerId && new Date(booking.startDate) < new Date()) {
					booking.status = "cancelled";
					await booking.save();
				}

				const payments = await PaymentModel.find({ bookingId: booking._id });

				const bookingDetail = {
					...booking.toObject(),
					payments: payments.map((payment) => ({
						amount: payment.amount,
						date: payment.date,
						status: payment.status,
						paymentIntentId: payment.paymentIntentId,
						clientSecret: payment.clientSecret,
					})),
				};

				if (booking.status === "cancelled" || booking.status === "completed") {
					history.push(bookingDetail);
				} else if ((booking.status === "pending" || booking.status == "in progress") && booking.providerId) {
					active.push(bookingDetail);
				} else if (booking.status === "pending" && !booking.providerId) {
					scheduled.push(bookingDetail);
				}

				history.sort((a: any, b: any) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
				active.sort((a: any, b: any) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
				scheduled.sort((a: any, b: any) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
			}),
		);

		res.status(200).json({ history, active, scheduled });
	} catch (error) {
		console.error("Error fetching user bookings:", error);
		res.status(500).json({
			message: "An error occurred while fetching bookings.",
		});
	}
};

export const handleGetBookingById = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.body;
		if (!bookingId) {
			return res.status(400).json({ message: "No booking id provided." });
		}
		const booking = await BookingModel.findById(bookingId).populate("providerId").exec();
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

export const handleApproveStartJobRequest = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.body;
		if (!bookingId) {
			return res.status(400).json({ message: "Booking ID is required." });
		}

		const booking = await BookingModel.findById(bookingId);

		if (!booking || booking.status !== "pending" || !booking.userApprovalRequested || !booking?.providerId) {
			return res.status(404).json({ message: "Booking not found or not pending." });
		}

		booking.status = "in progress";
		booking.startedAt = new Date();
		await booking.save();

		await sendBookingStartApprovedNotification(booking.providerId?.toString(), bookingId);

		res.status(200).json({ message: "Booking has been started." });
	} catch (error) {
		console.error("Error approving start job request:", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

const sendBookingStartApprovedNotification = async (userId: string, bookingId: string) => {
	try {
		const notificationMessage = {
			include_aliases: { external_id: [userId] },
			contents: { en: `Your start request was approved!` },
			headings: { en: "You can start the job. Your time is being tracked." },
			data: {
				screen: "MyOrderDetails",
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
