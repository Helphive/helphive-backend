import { Request, Response } from "express";
import stripe from "../service-accounts/stripe";
import { sendNotification, storeNotification } from "../service-accounts/onesignal";
import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import PayoutModel from "../../dal/models/payout.model";
import { SUPPORT_EMAIL } from "../../config/config";
import Stripe from "stripe";
import RefundEmail from "../../emails/refundEmail";
import { describeBooking, formatMoney } from "../user-controllers/utils/booking.utils";
import { sendEmail } from "../../lib/email";
import { emitEvent } from "../../lib/events";
import log from "../../lib/logger";
import { refundTotals } from "../../lib/operations";
import { beginStripeDelivery, trackWebhookWork, type WebhookDelivery } from "../../lib/webhookRecorder";
import { recordDisputeEvent } from "./disputes.webhook";

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const connectedEndpointSecret = process.env.STRIPE_CONNECTED_WEBHOOK_SECRET || "";
const supportEmail = SUPPORT_EMAIL || "";

/**
 * The verified Stripe event, or null after answering. An empty signing secret would let anyone sign events (Stripe's
 * library accepts it), so a missing secret refuses every call instead.
 */
const verifyStripeEvent = (req: Request, res: Response, secret: string, name: string): Stripe.Event | null => {
	if (!secret) {
		log.error(`${name} is not set; refusing Stripe webhook calls.`);
		res.status(503).json({ message: "Webhook not configured." });
		return null;
	}
	const sig = req.headers["stripe-signature"];
	if (typeof sig !== "string" || !Buffer.isBuffer(req.body)) {
		res.status(400).json({ message: "Invalid signature." });
		return null;
	}
	try {
		return stripe.webhooks.constructEvent(req.body, sig, secret);
	} catch (err: any) {
		log.warn("Stripe webhook signature verification failed", { reason: err?.message });
		res.status(400).json({ message: "Invalid signature." });
		return null;
	}
};

/**
 * Each verified event is recorded (webhookevents) with what came of it. An event id already processed is answered
 * 200 without running the handler again; every handler below was already safe to repeat, so this only saves work.
 */
const dispatch = async (
	endpoint: "platform" | "connected",
	event: Stripe.Event,
	handle: (delivery: WebhookDelivery) => void,
) => {
	const delivery = await beginStripeDelivery(endpoint, event);
	// A redelivery only bumps the record's delivery count; its outcome stays what the first delivery recorded.
	if (!delivery.shouldProcess) return;
	handle(delivery);
};

export const handleStripeWebhook = async (req: Request, res: Response) => {
	const event = verifyStripeEvent(req, res, endpointSecret, "STRIPE_WEBHOOK_SECRET");
	if (!event) return;

	await dispatch("platform", event, (delivery) => {
		switch (event.type) {
			case "payment_intent.succeeded":
				trackWebhookWork(delivery, updatePaymentStatus(event.data.object.id, "completed"));
				break;
			case "payment_intent.payment_failed":
				// Recorded as an event only; the booking stays unpaid and the customer can try again, as before.
				trackWebhookWork(delivery, recordPaymentFailed(event.data.object));
				break;
			case "refund.updated": {
				const refund = event.data.object;
				if (refund.status === "succeeded") {
					trackWebhookWork(delivery, updateRefundStatus(refund, "succeeded"));
				} else if (refund.status === "failed") {
					trackWebhookWork(delivery, updateRefundStatus(refund, "failed"));
				} else if (refund.status === "canceled") {
					trackWebhookWork(delivery, updateRefundStatus(refund, "cancelled"));
				} else {
					delivery.finish("ignored", { note: `refund status ${refund.status}` });
				}
				break;
			}
			case "refund.failed":
				trackWebhookWork(delivery, updateRefundStatus(event.data.object, "failed"));
				break;
			// Card disputes (controllers/webhook-controllers/disputes.webhook.ts).
			case "charge.dispute.created":
			case "charge.dispute.updated":
			case "charge.dispute.funds_withdrawn":
			case "charge.dispute.funds_reinstated":
			case "charge.dispute.closed":
				trackWebhookWork(delivery, recordDisputeEvent(event));
				break;

			default:
				log.info(`Unhandled Stripe event type ${event.type}`);
				delivery.finish("ignored");
		}
	});

	return res.status(200).json({ message: "Stripe webhook received" });
};

const updatePaymentStatus = async (
	paymentIntentId: string,
	status: "pending" | "completed" | "cancelled",
): Promise<string | void> => {
	try {
		// Stripe can deliver an event more than once; only the first transition notifies anyone.
		const payment = await PaymentModel.findOneAndUpdate(
			{ paymentIntentId, status: { $ne: status } },
			{ $set: { status, ...(status === "completed" ? { paidAt: new Date() } : {}) } },
			{ new: true },
		);
		if (!payment) {
			log.info(`Payment with intent ID ${paymentIntentId} not found or already ${status}.`);
			return `payment not found or already ${status}`;
		}
		const booking = await BookingModel.findById(payment.bookingId);
		if (!booking) {
			log.error(`Booking with ID ${payment.bookingId} not found.`);
			return "booking not found";
		}
		if (status === "completed") {
			const subjects = { userId: booking.userId, bookingId: booking._id, paymentId: payment._id };
			emitEvent({
				type: "payment.succeeded",
				actor: { type: "system" },
				subjects,
				properties: { amount: payment.amount },
			});
			emitEvent({
				type: "booking.paid",
				actor: { type: "system" },
				subjects,
				properties: { amount: payment.amount },
			});
		}
		await sendPaymentSucceededNotification(booking);
		await sendBookingNotification(payment.bookingId, booking);
		log.info(`Payment status updated to ${status} for intent ID ${paymentIntentId}.`);
	} catch (error) {
		log.error(`Error updating payment status for intent ID ${paymentIntentId}`, error);
		throw error;
	}
};

const recordPaymentFailed = async (intent: Stripe.PaymentIntent): Promise<string | void> => {
	const payment = await PaymentModel.findOne({ paymentIntentId: intent.id }).select("_id bookingId").lean().exec();
	emitEvent({
		type: "payment.failed",
		actor: { type: "system" },
		subjects: { bookingId: payment?.bookingId ?? intent.metadata?.bookingId, paymentId: payment?._id },
		properties: {
			failureCode: intent.last_payment_error?.code ?? null,
			declineCode: intent.last_payment_error?.decline_code ?? null,
		},
	});
	return payment ? undefined : "payment not found";
};

const sendPaymentSucceededNotification = async (booking: InstanceType<typeof BookingModel>) => {
	const bookingId = (booking._id as any).toString();
	const userId = booking.userId.toString();
	try {
		const title = "Payment received";
		const message = `Your payment for the ${describeBooking(booking)} booking was successful. We are finding you a provider.`;
		await sendNotification({
			include_aliases: { external_id: [userId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "BookingDetails", bookingId, type: "payment_succeeded" },
		});
		await storeNotification(title, message, userId, "BookingDetails", "payment_succeeded", bookingId);
	} catch (error: any) {
		log.error(`Error sending payment notification for booking ID ${bookingId}`, error);
	}
};

/** Tells available approved providers within 25 km about an open job (after payment, or when an admin reopens it). */
export const sendBookingNotification = async (bookingId: any, booking: InstanceType<typeof BookingModel>) => {
	try {
		// Only approved providers hear about new jobs; anyone else could not open or accept them anyway.
		const availableProviders = await UserModel.find({
			isProviderAvailable: true,
			"roles.Provider": true,
			providerStatus: "approved",
			// Suspension turns availability off; this also covers an update that raced it.
			suspended: { $ne: true },
		}).select("_id currentLocation");
		const providersInRadius = availableProviders.filter((provider) => {
			const distance = getDistanceFromLatLonInKm(
				booking.latitude,
				booking.longitude,
				provider.currentLocation?.latitude ?? 0,
				provider.currentLocation?.longitude ?? 0,
			);
			return distance <= 25;
		});

		if (providersInRadius.length === 0) {
			log.info(`No providers available within 25km radius for booking ID ${bookingId}.`);
			return;
		}

		const providerIds = providersInRadius.map((provider) => (provider._id as any).toString());

		const title = "New job available";
		const message = `A ${describeBooking(booking)} job is available near you. Accept it before someone else does.`;

		await sendNotification({
			include_aliases: { external_id: providerIds },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "AcceptOrder", bookingId: bookingId.toString(), type: "booking_created" },
		});
		for (const provider of providerIds) {
			await storeNotification(title, message, provider, "AcceptOrder", "booking_created", bookingId.toString());
		}
	} catch (error: any) {
		log.error(`Error sending booking notification for booking ID ${bookingId} to available providers`, error);
	}
};

function getDistanceFromLatLonInKm(latitude: number, longitude: number, latitude1: number, longitude1: number) {
	const R = 6371;
	const dLat = deg2rad(latitude1 - latitude);
	const dLon = deg2rad(longitude1 - longitude);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(deg2rad(latitude)) * Math.cos(deg2rad(latitude1)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	const distance = R * c;
	return distance;
}

function deg2rad(deg: number) {
	return deg * (Math.PI / 180);
}

export const handleStripeConnectedPayoutsWebhook = async (req: Request, res: Response) => {
	const event = verifyStripeEvent(req, res, connectedEndpointSecret, "STRIPE_CONNECTED_WEBHOOK_SECRET");
	if (!event) return;

	await dispatch("connected", event, (delivery) => {
		switch (event.type) {
			case "payout.paid":
				trackWebhookWork(delivery, updatePayoutStatus(event.data.object.id, "paid"));
				break;

			case "payout.failed":
				trackWebhookWork(delivery, updatePayoutStatus(event.data.object.id, "failed"));
				break;

			case "payout.canceled":
				trackWebhookWork(delivery, updatePayoutStatus(event.data.object.id, "cancelled"));
				break;

			default:
				log.info(`Unhandled Stripe event type ${event.type}`);
				delivery.finish("ignored");
		}
	});

	return res.status(200).json({ message: "Stripe webhook received" });
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const updatePayoutStatus = async (
	payoutId: string,
	status: "paid" | "failed" | "cancelled",
): Promise<string | void> => {
	try {
		// The payout record is written just after Stripe creates the payout; give it a moment to exist.
		await delay(5000);
		// One atomic transition per status. Failed and cancelled are final, so a redelivered event can never credit
		// the balance twice.
		const now = new Date();
		const previous = await PayoutModel.findOneAndUpdate(
			{ payoutId, status: { $nin: ["failed", "cancelled", status] } },
			{ $set: { status, ...(status === "paid" ? { paidAt: now } : { failedAt: now }) } },
			{ new: false },
		);
		if (!previous) {
			log.info(`Payout ${payoutId} not found or already ${status}.`);
			return `payout not found or already ${status}`;
		}
		if (status === "failed" || status === "cancelled") {
			await UserModel.updateOne({ _id: previous.userId }, { $inc: { availableBalance: previous.amount } });
		}
		emitEvent({
			type: status === "paid" ? "payout.paid" : "payout.failed",
			actor: { type: "system" },
			subjects: { providerId: previous.userId as any, payoutId: previous._id },
			properties: status === "paid" ? { amount: previous.amount } : { status, amount: previous.amount },
		});

		if (status === "paid") {
			await sendPayoutPaidNotification(previous.userId.toString(), previous.amount);
		}
	} catch (error) {
		log.error(`Error updating payout status for payout ID ${payoutId}`, error);
		throw error;
	}
};

const sendPayoutPaidNotification = async (userId: string, amount: number) => {
	try {
		const title = "Payout sent";
		const message = `Your ${formatMoney(amount)} payout has been paid to your bank account.`;
		await sendNotification({
			include_aliases: { external_id: [userId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "Earnings", type: "payout_paid" },
		});
		await storeNotification(title, message, userId, "Earnings", "payout_paid");
	} catch (error) {
		log.error(`Error sending payout notification for user ID ${userId}`, error);
	}
};

const updateRefundStatus = async (
	refund: Stripe.Refund,
	status: "pending" | "succeeded" | "failed" | "cancelled",
): Promise<string | void> => {
	try {
		await delay(5000);
		if (typeof refund.id !== "string" || !refund.id) return "refund without id";
		// The latest refund is in the top-level fields; an admin's earlier partial refunds are only in `refunds`.
		const payment = await PaymentModel.findOne({
			$or: [{ refundId: refund.id }, { "refunds.refundId": refund.id }],
		});
		if (!payment) {
			log.error(`Refund with ID ${refund.id} not found.`);
			return "refund not found";
		}
		const entry = payment.refunds?.find((item) => item.refundId === refund.id);
		const isLatest = payment.refundId === refund.id;
		// Stripe may redeliver refund.updated; only notify on the first transition to succeeded.
		const previousStatus = entry ? entry.status : payment.refundStatus;
		if (entry) entry.status = status;
		if (isLatest) {
			payment.refundStatus = status;
			// With admin refunds the top-level amount is the total refunded; otherwise this refund's amount, as before.
			payment.refundAmount = entry ? refundTotals(payment).committedCents / 100 : refund.amount / 100;
			payment.refundCreated = new Date(refund.created * 1000);
			payment.destinationDetails = {
				type: refund.destination_details?.type,
			};
		}
		await payment.save();

		if (previousStatus !== status && (status === "succeeded" || status === "failed" || status === "cancelled")) {
			emitEvent({
				type: status === "succeeded" ? "refund.succeeded" : "refund.failed",
				actor: { type: "system" },
				subjects: { bookingId: payment.bookingId, paymentId: payment._id },
				properties:
					status === "succeeded" ? { amount: refund.amount / 100 } : { status, amount: refund.amount / 100 },
			});
		}

		if (status == "succeeded" && previousStatus !== "succeeded") {
			return await notifyRefundSucceeded(payment, refund.amount / 100, refund.id);
		}
	} catch (error) {
		log.error(`Error updating refund status for refund ID ${refund.id}`, error);
		throw error;
	}
};

/**
 * Tells the customer a refund went through: the refund email (under the email policy) and the in-app notification.
 * Used by the refund webhook and by an admin refund Stripe confirms at once. Returns a note when it could not.
 */
export const notifyRefundSucceeded = async (
	payment: InstanceType<typeof PaymentModel>,
	amount: number,
	refundId: string,
): Promise<string | void> => {
	const booking = await BookingModel.findOne({ _id: payment.bookingId });
	if (!booking) {
		log.error(`Booking with ID ${payment.bookingId} not found.`);
		return "booking not found";
	}
	const user = await UserModel.findOne({ _id: booking.userId });
	if (!user) {
		log.error(`User with ID ${booking.userId} not found.`);
		return "user not found";
	}
	await sendRefundEmail(user, payment, amount, refundId);
	await sendRefundNotification(String(user._id), booking, amount);
};

/** Refund notice. Skipped (and recorded) for addresses the recipient policy blocks, such as the demo customer. */
const sendRefundEmail = async (
	user: InstanceType<typeof UserModel>,
	payment: InstanceType<typeof PaymentModel>,
	amount: number,
	refundId: string,
) => {
	const result = await sendEmail({
		template: "refund",
		from: `Helphive <${supportEmail}>`,
		to: user.email,
		subject: "A Payment was Refunded to your Account",
		react: RefundEmail({
			bookingId: `#${payment.bookingId.toString().slice(-6).toUpperCase()}`,
			refundAmount: amount,
			refundId: `#${refundId.slice(-6).toUpperCase()}`,
			refundCreated: payment.refundCreated || new Date(),
			refundStatus: "succeeded",
			destinationAccountType: payment.destinationDetails.type,
		}),
		userId: String(user._id),
	});
	if (result.status === "failed") log.error("Error sending refund email", { error: result.error });
};

const sendRefundNotification = async (userId: string, booking: any, refundAmount: number) => {
	const bookingId = booking._id.toString();
	try {
		const title = `${formatMoney(refundAmount)} refunded`;
		const message =
			booking.status === "cancelled"
				? `Your ${describeBooking(booking)} booking was cancelled and ${formatMoney(refundAmount)} was refunded to your original payment method.`
				: `${formatMoney(refundAmount)} for your ${describeBooking(booking)} booking was refunded to your original payment method.`;
		await sendNotification({
			include_aliases: { external_id: [userId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "BookingDetails", bookingId, type: "payment_refunded" },
		});
		await storeNotification(title, message, userId, "BookingDetails", "payment_refunded", bookingId);
	} catch (error) {
		log.error(`Error sending refund notification for booking ID ${bookingId}`, error);
	}
};
