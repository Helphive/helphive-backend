import { NextFunction, Request, Response } from "express";
import { validationResult } from "express-validator";

import stripe from "../service-accounts/stripe";

import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import { createGoogleCloudTaskBookingExpiredTrigger, sendBookingStartApprovedNotification } from "./utils/user.utils";
import { isValidObjectId, withDisplayStatus } from "./utils/booking.utils";
import { resolveBookingStart } from "./utils/bookingStart.utils";
import { COUNTERPARTY_SELECT, withCounterparties } from "./utils/counterparty.utils";
import { serializePayment } from "./utils/payment.utils";
import { publicValidationErrors } from "../../middleware/sanitizeInput";
import { emitEvent } from "../../lib/events";
import log from "../../lib/logger";

declare module "express" {
	interface Request {
		user?: string;
		roles?: { User: boolean; Provider: boolean };
		bookingId?: string;
	}
}

export const handleCreateBooking = async (req: Request, res: Response, next: NextFunction) => {
	const errors = validationResult(req);
	if (!errors.isEmpty()) {
		return res.status(400).json({
			message: "Invalid Request.",
			errors: publicValidationErrors(errors),
		});
	}

	try {
		const { service, rate, startAt, startDate, startTime, hours, address, latitude, longitude } = req.body;

		const userEmail = req.user;

		const user = await UserModel.findOne({ email: userEmail });

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const now = new Date();
		const combinedDate = resolveBookingStart({ startAt, startDate, startTime }, now);
		if (!combinedDate) {
			return res.status(400).json({ message: "Start date and time are not valid." });
		}

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
		emitEvent(
			{
				type: "booking.created",
				actor: { type: "user", id: user._id },
				subjects: { userId: user._id, bookingId: newBooking._id },
				properties: {
					serviceId: newBooking.service.id,
					rate: newBooking.rate,
					hours: newBooking.hours,
					amount: newBooking.rate * newBooking.hours,
					startDate: newBooking.startDate,
					leadTimeMs: newBooking.startDate.getTime() - now.getTime(),
				},
			},
			req,
		);

		await createGoogleCloudTaskBookingExpiredTrigger(
			String(newBooking._id),
			new Date(newBooking.startDate.getTime()),
		);

		req.bookingId = String(newBooking._id);
		next();
	} catch (error) {
		log.error("Error handling create booking", error);
		res.status(500).json({
			message: "An error occurred while processing the request.",
		});
	}
};

/**
 * Payment intent for a booking of the caller's. After create-booking the booking id comes from req.bookingId; the
 * standalone route takes it from the body. The amount is always computed from the stored booking.
 */
export const handleCreatePaymentIntent = async (req: Request, res: Response) => {
	try {
		const bookingId = req.bookingId ?? req.body?.bookingId;
		if (!isValidObjectId(bookingId)) {
			return res.status(400).json({ message: "Invalid booking id." });
		}
		const user = await UserModel.findOne({ email: req.user }).select("_id").exec();
		const booking = await BookingModel.findById(bookingId).exec();
		if (!user || !booking || booking.userId.toString() !== String(user._id)) {
			return res.status(404).json({ message: "Booking not found." });
		}
		if (booking.status !== "pending" || booking.providerId) {
			return res.status(400).json({ message: "This booking can no longer be paid." });
		}

		// Reuse an open payment rather than creating a second charge for the same booking.
		const existing = await PaymentModel.findOne({ bookingId: booking._id }).sort({ createdAt: -1 }).exec();
		if (existing?.status === "completed") {
			return res.status(400).json({ message: "This booking has already been paid." });
		}
		if (existing?.paymentIntentId && existing.clientSecret) {
			return res.json({
				bookingId: String(booking._id),
				paymentIntentId: existing.paymentIntentId,
				clientSecret: existing.clientSecret,
			});
		}

		const paymentAmount = booking.rate * booking.hours;
		const paymentIntent = await stripe.paymentIntents.create(
			{
				amount: Math.round(paymentAmount * 100),
				currency: "usd",
				metadata: { bookingId: String(booking._id) },
			},
			{ idempotencyKey: `booking-payment-${String(booking._id)}` },
		);

		const newPayment = new PaymentModel({
			bookingId: booking._id,
			amount: paymentAmount,
			date: new Date(),
			status: "pending",
			paymentIntentId: paymentIntent.id,
			clientSecret: paymentIntent.client_secret,
		});
		await newPayment.save();

		res.json({
			bookingId: String(booking._id),
			paymentIntentId: paymentIntent.id,
			clientSecret: paymentIntent.client_secret,
		});
	} catch (error) {
		log.error("Error handling create payment intent", error);
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
		const allPayments = await PaymentModel.find({ bookingId: { $in: bookings.map((booking) => booking._id) } });

		const paymentsByBooking = new Map<string, typeof allPayments>();
		for (const payment of allPayments) {
			const key = payment.bookingId.toString();
			paymentsByBooking.set(key, [...(paymentsByBooking.get(key) ?? []), payment]);
		}

		const history = [] as any;
		const active = [] as any;
		const scheduled = [] as any;

		for (const booking of bookings) {
			const bookingDetail = {
				...withDisplayStatus(booking),
				payments: (paymentsByBooking.get((booking._id as any).toString()) ?? []).map((payment) => ({
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
		}

		const byStartDateDesc = (a: any, b: any) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
		history.sort(byStartDateDesc);
		active.sort(byStartDateDesc);
		scheduled.sort(byStartDateDesc);

		res.status(200).json({ history, active, scheduled });
	} catch (error) {
		log.error("Error fetching user bookings", error);
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
		if (!isValidObjectId(bookingId)) {
			return res.status(400).json({ message: "Invalid booking id." });
		}

		const user = await UserModel.findOne({ email: req.user });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const booking = await BookingModel.findById(bookingId).populate("providerId", COUNTERPARTY_SELECT).exec();
		if (!booking) {
			return res.status(404).json({ message: "Booking not found." });
		}

		if (booking.userId.toString() !== (user._id as any).toString()) {
			return res.status(403).json({ message: "User not authorized to view this booking." });
		}

		const payment = await PaymentModel.findOne({ bookingId }).exec();
		if (!payment) {
			return res.status(404).json({ message: "Payment details not found for this booking." });
		}

		res.status(200).json({
			booking: withCounterparties(withDisplayStatus(booking)),
			payment: serializePayment(payment, { includeClientSecret: true }),
		});
	} catch (error) {
		log.error("Error getting booking by id", error);
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

		if (!isValidObjectId(bookingId)) {
			return res.status(400).json({ message: "Invalid booking id." });
		}

		const user = await UserModel.findOne({ email: req.user });
		const booking = await BookingModel.findById(bookingId);

		if (!booking || booking.status !== "pending" || !booking.userApprovalRequested || !booking?.providerId) {
			return res.status(404).json({ message: "Booking not found or not pending." });
		}

		if (!user || booking.userId.toString() !== (user._id as any).toString()) {
			return res.status(403).json({ message: "User not authorized to approve this booking." });
		}

		const startedAt = new Date();
		const started = await BookingModel.findOneAndUpdate(
			{ _id: booking._id, status: "pending", userApprovalRequested: true, providerId: booking.providerId },
			{ $set: { status: "in progress", startedAt } },
			{ new: true },
		).exec();
		if (!started) {
			return res.status(404).json({ message: "Booking not found or not pending." });
		}
		const subjects = { userId: started.userId, providerId: started.providerId, bookingId: started._id };
		emitEvent(
			{
				type: "booking.start_approved",
				actor: { type: "user", id: user._id },
				subjects,
				properties: {
					approvalWaitMs: started.startRequestedAt
						? startedAt.getTime() - started.startRequestedAt.getTime()
						: null,
				},
			},
			req,
		);
		emitEvent(
			{
				type: "booking.started",
				actor: { type: "user", id: user._id },
				subjects,
				properties: { offsetFromStartMs: startedAt.getTime() - started.startDate.getTime() },
			},
			req,
		);

		await sendBookingStartApprovedNotification(booking.providerId.toString(), started);

		res.status(200).json({ message: "Booking has been started." });
	} catch (error) {
		log.error("Error approving start job request", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};
