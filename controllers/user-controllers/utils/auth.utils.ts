import { sendNotification, storeNotification } from "../../service-accounts/onesignal";
import { googleCloudTasks } from "../../service-accounts/cloud-tasks";
import stripe from "../../service-accounts/stripe";
import PaymentModel from "../../../dal/models/payment.model";
import { describeBooking } from "./booking.utils";
import { hasRefund } from "./payment.utils";
import { GOOGLE_CLOUD_TASKS_QUEUE_PATH, SERVER_BASE_URL } from "../../../config/config";

/**
 * Refunds a booking's payment in full when it was paid and not refunded yet. Used by cancellation and expiry; the
 * idempotency key makes Stripe return the same refund if two of them race.
 */
export const refundPaymentIfPaid = async (bookingId: string) => {
	const payment = await PaymentModel.findOne({ bookingId }).exec();
	if (!payment || !payment.paymentIntentId || payment.status !== "completed" || hasRefund(payment)) return;
	const paymentIntent = await stripe.paymentIntents.retrieve(payment.paymentIntentId);
	if (paymentIntent.status !== "succeeded") {
		console.log(`Payment intent ${payment.paymentIntentId} was not paid, no refund needed.`);
		return;
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
		console.error(`Error sending booking completed notification for booking ID ${bookingId}:`, error.response);
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
		console.error(`Error sending booking cancellation notification for booking ID ${bookingId}:`, error.response);
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
