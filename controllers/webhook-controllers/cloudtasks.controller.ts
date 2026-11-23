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
import { sendBookingEvent } from "../../lib/chat/sendBookingEvent";
import { getSettings } from "../../lib/settings";
import {
	decideNoShow,
	noShowCheckAt,
	noShowDueAt,
	noShowTransitionFilter,
	NO_SHOW_CANCELLATION_REASON,
} from "../../lib/noShow";
import {
	createGoogleCloudTaskBookingNoShowTrigger,
	sendBookingNoShowNotification,
} from "../user-controllers/utils/user.utils";
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
		log.error("processing_earning_payout_failed", "Error processing earning payout", error);

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
		log.error(
			"sending_payment_notification_failed",
			`Error sending payment notification for booking ID ${bookingId}`,
			error,
		);
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
		log.error("expiring_booking_failed", "Error expiring booking", error);
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
		log.error(
			"sending_booking_expired_failed",
			`Error sending booking expired notification for booking ID ${bookingId}`,
			error,
		);
	}
};

/**
 * The no-show check, scheduled when a provider accepts (lib/noShow.ts has the rule). A booking still accepted with no
 * start request once its shift and the grace period are over is cancelled, both people are told (notification and the
 * chat's cancelled card) and the customer is refunded in full. A check that runs before the due time schedules itself
 * again. Safe to run twice: the cancellation is one conditional update, and a run that failed at the refund finds the
 * booking already cancelled by this rule and only requests the refund (same idempotency key).
 */
export const handleGoogleCloudTasksBookingNoShow = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.body;

		if (!isValidObjectId(bookingId)) {
			return res.status(200).json({ message: "Booking ID is required" });
		}

		const existing = await BookingModel.findById(bookingId).exec();
		if (!existing) {
			return res.status(200).json({ message: "Booking not found" });
		}

		const now = new Date();
		const graceMinutes = (await getSettings())["bookings.noShowGraceMinutes"];
		const decision = decideNoShow(existing, now, graceMinutes);

		if (decision === "not_applicable") {
			return res.status(200).json({ message: "Booking is not pending with a provider and no start request" });
		}

		if (decision === "not_due") {
			const dueAt = noShowDueAt(existing, graceMinutes) as Date;
			await createGoogleCloudTaskBookingNoShowTrigger(String(existing._id), noShowCheckAt(dueAt, now));
			return res.status(200).json({ message: "Booking is not due yet; the check was scheduled again" });
		}

		if (decision === "refund_only") {
			const retried = await refundPaymentIfPaid(String(existing._id));
			return res.status(200).json({
				message:
					retried.outcome === "refund_requested"
						? "Booking was cancelled earlier (not started); the refund was requested now"
						: "Booking already cancelled (not started) and its refund already handled",
			});
		}

		const booking = await BookingModel.findOneAndUpdate(
			noShowTransitionFilter(existing._id, existing.providerId),
			{ $set: { status: "cancelled", cancelledAt: now, cancellationReason: NO_SHOW_CANCELLATION_REASON } },
			{ new: true },
		).exec();
		if (!booking) {
			return res.status(200).json({ message: "Booking is not pending any more" });
		}
		emitEvent({
			type: "booking.no_show",
			actor: { type: "system" },
			subjects: { userId: booking.userId, providerId: booking.providerId, bookingId: booking._id },
			properties: {
				sinceEndMs: now.getTime() - (booking.startDate.getTime() + booking.hours * 60 * 60 * 1000),
				graceMinutes,
			},
		});

		await sendBookingNoShowNotification(String(booking.userId), String(booking.providerId), booking);
		// Nobody is waiting on this response, so the chat card is sent to the end (it never throws). Sent as the customer.
		await sendBookingEvent(booking._id, "cancelled");
		try {
			await syncBookingChat(booking);
		} catch (error) {
			log.error("re_deciding_chat_failed", "Error re-deciding the chat after a not-started cancellation", error);
		}

		// Last, so a failure here answers 500 and the retry finds the booking cancelled and only requests the refund.
		const refund = await refundPaymentIfPaid(String(booking._id));

		return res.status(200).json({
			message:
				refund.outcome === "refund_requested"
					? "Booking cancelled (not started) and refund requested"
					: "Booking cancelled (not started); nothing to refund",
		});
	} catch (error) {
		log.error("handling_no_show_failed", "Error handling the no-show check", error);
		return res.status(500).json({ message: "Internal server error" });
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
		log.error("checking_chat_window_failed", "Error checking a chat window", error);
		return res.status(500).json({ message: "Internal server error" });
	}
};
