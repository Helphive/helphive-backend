import { Request, Response } from "express";
import BookingModel from "../../dal/models/booking.model";
import EarningModel from "../../dal/models/earning.model";
import UserModel from "../../dal/models/user.model";
import stripe from "../service-accounts/stripe";

import { sendNotification, storeNotification } from "../service-accounts/onesignal";
import { EXPIRED_CANCELLATION_REASON } from "../user-controllers/utils/booking.utils";
import { describeBooking, formatMoney, isValidObjectId } from "../user-controllers/utils/booking.utils";
import { refundPaymentIfPaid } from "../user-controllers/utils/auth.utils";
import { emitEvent } from "../../lib/events";
import { syncBookingChat } from "../../lib/chat/chatSync";
import { blocksEarningRelease, recordBlocked } from "../../lib/risk/holds";
import log from "../../lib/logger";

export const handleGoogleCloudTasksEarningComplete = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.body;

		if (!isValidObjectId(bookingId)) {
			return res.status(200).json({ message: "Booking ID is required" });
		}

		const booking = await BookingModel.findById(bookingId);
		if (!booking || booking.status !== "completed") {
			return res.status(200).json({ message: "Booking not found or not completed" });
		}

		const provider = await UserModel.findById(booking.providerId);
		if (!provider || !provider.stripeConnectedAccountId) {
			return res.status(200).json({ message: "Provider not found or missing Stripe connected account" });
		}

		const earning = await EarningModel.findOne({ bookingId });
		if (!earning) {
			return res.status(200).json({ message: "Earning record not found" });
		}

		if (earning.status === "cancelled") {
			return res.status(200).json({ message: "Earning already cancelled" });
		}

		if (earning.status === "completed") {
			return res.status(200).json({ message: "Earning already processed" });
		}

		// A risk payout hold keeps the earning pending; releasing the hold schedules this task again.
		if (blocksEarningRelease(provider.payoutHold)) {
			recordBlocked(provider._id, "earnings");
			emitEvent({
				type: "earning.held",
				actor: { type: "system" },
				subjects: { providerId: provider._id, bookingId: booking._id, earningId: earning._id },
				properties: { amount: earning.amount },
			});
			return res.status(200).json({ message: "Earning not released: provider payouts are on hold" });
		}

		const account = await stripe.accounts.retrieve(provider.stripeConnectedAccountId);

		if (account.details_submitted === false) {
			return res.status(200).json({ message: "Provider has not completed Stripe onboarding" });
		}

		const amountInCents = Math.round(earning.amount * 100);
		const platformBalance = await stripe.balance.retrieve();
		const availablePlatformBalance = platformBalance.available.find((balance) => balance.currency === "usd");

		if (!availablePlatformBalance || availablePlatformBalance.amount < amountInCents) {
			return res.status(200).json({ message: "Insufficient platform balance for payout" });
		}

		// Cloud Tasks delivers at least once. The idempotency key makes a repeated run get the same transfer back,
		// and the conditional update below credits the balance only on the run that completes the earning.
		const transfer = await stripe.transfers.create(
			{
				amount: amountInCents,
				currency: "usd",
				destination: provider.stripeConnectedAccountId,
			},
			{ idempotencyKey: `earning-transfer-${String(earning._id)}` },
		);

		const completed = await EarningModel.findOneAndUpdate(
			{ _id: earning._id, status: "pending" },
			{ $set: { status: "completed", completionDate: new Date(), transferId: transfer.id } },
			{ new: true },
		);
		if (!completed) {
			return res.status(200).json({ message: "Earning already processed" });
		}

		await UserModel.updateOne({ _id: provider._id }, { $inc: { availableBalance: earning.amount } });
		emitEvent({
			type: "earning.released",
			actor: { type: "system" },
			subjects: { providerId: provider._id, bookingId: booking._id, earningId: earning._id },
			properties: {
				amount: earning.amount,
				waitedMs: (completed.completionDate?.getTime() ?? Date.now()) - new Date(earning.date).getTime(),
			},
		});

		await sendPaymentNotification(String(provider._id), earning.amount, booking);

		return res.status(200).json({
			message: "Payment processed successfully",
			transferId: transfer.id,
		});
	} catch (error: any) {
		log.error("Error processing earning payout", error);

		if (error.type === "StripeCardError") {
			return res.status(400).json({ message: error.message });
		}

		return res.status(500).json({ message: "Internal server error" });
	}
};

const sendPaymentNotification = async (providerId: string, amount: number, booking: any) => {
	const bookingId = booking._id.toString();
	try {
		const title = `${formatMoney(amount)} received`;
		const message = `Earnings from your ${describeBooking(booking)} job were released to your account.`;
		await sendNotification({
			include_aliases: { external_id: [providerId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "Earnings", bookingId, type: "payment_succeeded" },
		});
		await storeNotification(title, message, providerId, "Earnings", "payment_succeeded", bookingId);
	} catch (error) {
		log.error(`Error sending payment notification for booking ID ${bookingId}`, error);
	}
};

export const handleGoogleCloudTasksBookingExpired = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.body;

		if (!isValidObjectId(bookingId)) {
			return res.status(200).json({ message: "Booking ID is required" });
		}

		const existing = await BookingModel.findById(bookingId).exec();
		if (!existing) {
			return res.status(200).json({ message: "Booking not found" });
		}

		// Only an unassigned pending booking expires, and only once even if the task runs twice.
		const booking = await BookingModel.findOneAndUpdate(
			{ _id: existing._id, status: "pending", providerId: null },
			{
				$set: {
					status: "cancelled",
					cancelledAt: new Date(),
					cancelledBy: existing.userId,
					cancellationReason: EXPIRED_CANCELLATION_REASON,
				},
			},
			{ new: true },
		).exec();
		if (!booking) {
			return res.status(200).json({ message: "Booking is not pending" });
		}
		emitEvent({
			type: "booking.expired",
			actor: { type: "system" },
			subjects: { userId: booking.userId, bookingId: booking._id },
		});

		await sendBookingExpiredNotification(booking.userId.toString(), booking);

		await refundPaymentIfPaid(String(booking._id));

		return res.status(200).json({ message: "Booking expired" });
	} catch (error) {
		log.error("Error expiring booking", error);
		return res.status(500).json({ message: "Internal server error" });
	}
};

const sendBookingExpiredNotification = async (userId: string, booking: any) => {
	const bookingId = booking._id.toString();
	try {
		const title = "Booking expired";
		const message = `No provider accepted your ${describeBooking(booking)} booking in time. Any payment will be refunded.`;
		await sendNotification({
			include_aliases: { external_id: [userId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "BookingDetails", bookingId, type: "booking_expired" },
		});
		await storeNotification(title, message, userId, "BookingDetails", "booking_expired", bookingId);
	} catch (error) {
		log.error(`Error sending booking expired notification for booking ID ${bookingId}`, error);
	}
};

/**
 * Scheduled for when a booking's chat grace period ends: re-decides whether its customer and provider may still chat
 * (another booking may keep it open). Idempotent; a missing or unassigned booking is skipped.
 */
export const handleGoogleCloudTasksChatWindow = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.body;
		if (!isValidObjectId(bookingId)) return res.status(200).json({ message: "Booking ID is required" });
		const booking = await BookingModel.findById(bookingId).select("userId providerId").lean().exec();
		if (!booking?.providerId) return res.status(200).json({ message: "Booking has no provider" });
		const result = await syncBookingChat(booking);
		if (!result) return res.status(500).json({ message: "Chat relationship could not be checked" });
		return res.status(200).json({ message: result.state.allowed ? "Chat still open" : "Chat closed" });
	} catch (error) {
		log.error("Error checking a chat window", error);
		return res.status(500).json({ message: "Internal server error" });
	}
};
