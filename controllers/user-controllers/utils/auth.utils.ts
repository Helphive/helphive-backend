import { sendNotification, storeNotification } from "../../service-accounts/onesignal";
import { googleCloudTasks } from "../../service-accounts/cloud-tasks";
import stripe from "../../service-accounts/stripe";
import PaymentModel from "../../../dal/models/payment.model";
import { describeBooking } from "./booking.utils";
import { hasRefund } from "./payment.utils";
import { GOOGLE_CLOUD_TASKS_QUEUE_PATH, SERVER_BASE_URL } from "../../../config/config";
import { emitEvent } from "../../../lib/events";
import log from "../../../lib/logger";

export type RefundIfPaidResult =
	| { outcome: "refund_requested"; refundId: string; amount: number; paymentId: string }
	| { outcome: "no_payment" | "not_paid" | "already_refunded"; paymentId: string | null };

/**
 * Refunds a booking's payment in full when it was paid and not refunded yet. Used by cancellation and expiry (and by
 * an admin cancelling for a party); the idempotency key makes Stripe return the same refund if two of them race.
 * A payment that already has any refund, including an admin's partial one, is left alone. Returns what it did.
 */
export const refundPaymentIfPaid = async (bookingId: string): Promise<RefundIfPaidResult> => {
	const payment = await PaymentModel.findOne({ bookingId }).exec();
	if (!payment) return { outcome: "no_payment", paymentId: null };
	const paymentId = String(payment._id);
	if (!payment.paymentIntentId || payment.status !== "completed") return { outcome: "not_paid", paymentId };
	if (hasRefund(payment) || payment.refunds?.length) return { outcome: "already_refunded", paymentId };
	const paymentIntent = await stripe.paymentIntents.retrieve(payment.paymentIntentId);
	if (paymentIntent.status !== "succeeded") {
		log.info(`Payment intent ${payment.paymentIntentId} was not paid, no refund needed.`);
		return { outcome: "not_paid", paymentId };
	}
	const refund = await stripe.refunds.create(
		{ payment_intent: payment.paymentIntentId },
		{ idempotencyKey: `refund-${String(payment._id)}` },
	);
	payment.refundStatus = "pending";
	payment.refundId = refund.id;
	payment.refundAmount = refund.amount / 100;
	payment.refundCreated = new Date(refund.created * 1000);
	payment.destinationDetails = { type: refund.destination_details?.type };
	await payment.save();
	emitEvent({
		type: "refund.created",
		actor: { type: "system" },
		subjects: { bookingId: payment.bookingId, paymentId: payment._id },
		properties: { amount: payment.refundAmount },
	});
	return { outcome: "refund_requested", refundId: refund.id, amount: payment.refundAmount, paymentId };
};

export const sendBookingCompletedNotification = async (userId: string, providerId: string, booking: any) => {
	const bookingId = booking._id.toString();
	try {
		const details = describeBooking(booking);
		const recipients = [
			{
				id: userId,
				screen: "BookingDetails",
				title: "Booking completed",
				message: `Your ${details} has been completed. Thanks for using HelpHive!`,
			},
			{
				id: providerId,
				screen: "MyOrderDetails",
				title: "Job completed",
				message: `Your ${details} job is complete. Your earnings will be released shortly.`,
			},
		];
		for (const { id, screen, title, message } of recipients) {
			await sendNotification({
				include_aliases: { external_id: [id] },
				headings: { en: title },
				contents: { en: message },
				data: { screen, bookingId, type: "booking_completed" },
			});
			await storeNotification(title, message, id, screen, "booking_completed", bookingId);
		}
	} catch (error: any) {
		log.error(`Error sending booking completed notification for booking ID ${bookingId}`, error.response);
	}
};

export const sendBookingCancelledNotification = async (userId: string, providerId: string, booking: any) => {
	const bookingId = booking._id.toString();
	try {
		const details = describeBooking(booking);
		const recipients = [
			{
				id: userId,
				screen: "BookingDetails",
				title: "Booking cancelled",
				message: `Your ${details} booking has been cancelled.`,
			},
		];
		if (providerId) {
			recipients.push({
				id: providerId,
				screen: "MyOrderDetails",
				title: "Booking cancelled",
				message: `The ${details} booking has been cancelled.`,
			});
		}
		for (const { id, screen, title, message } of recipients) {
			await sendNotification({
				include_aliases: { external_id: [id] },
				headings: { en: title },
				contents: { en: message },
				data: { screen, bookingId, type: "booking_cancelled" },
			});
			await storeNotification(title, message, id, screen, "booking_cancelled", bookingId);
		}
	} catch (error: any) {
		log.error(`Error sending booking cancellation notification for booking ID ${bookingId}`, error.response);
	}
};

export const createGoogleCloudTaskPaymentTrigger = async (bookingId: string, scheduleDate: Date) => {
	const url = `${SERVER_BASE_URL}/webhook/google-cloud-tasks/earning-complete`;
	const payload = {
		bookingId,
	};
	const task = {
		parent: GOOGLE_CLOUD_TASKS_QUEUE_PATH,
		task: {
			httpRequest: {
				httpMethod: "POST" as const,
				url,
				body: Buffer.from(JSON.stringify(payload)).toString("base64"),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.GOOGLE_CLOUD_TASKS_SECRET}`,
				},
			},
			scheduleTime: {
				seconds: scheduleDate.getTime() / 1000,
			},
		},
	};
	await googleCloudTasks.createTask(task);
};
