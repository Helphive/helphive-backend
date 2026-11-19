import { Request, Response } from "express";
import { Resend } from "resend";
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

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const connectedEndpointSecret = process.env.STRIPE_CONNECTED_WEBHOOK_SECRET || "";
const resend = new Resend(process.env.RESEND_API_KEY);
const supportEmail = SUPPORT_EMAIL || "";

/**
 * The verified Stripe event, or null after answering. An empty signing secret would let anyone sign events (Stripe's
 * library accepts it), so a missing secret refuses every call instead.
 */
const verifyStripeEvent = (req: Request, res: Response, secret: string, name: string): Stripe.Event | null => {
	if (!secret) {
		console.error(`${name} is not set; refusing Stripe webhook calls.`);
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
		console.log(`Stripe Webhook signature verification failed:`, err.message);
		res.status(400).json({ message: "Invalid signature." });
		return null;
	}
};

export const handleStripeWebhook = async (req: Request, res: Response) => {
	const event = verifyStripeEvent(req, res, endpointSecret, "STRIPE_WEBHOOK_SECRET");
	if (!event) return;

	switch (event.type) {
		case "payment_intent.succeeded":
			const paymentIntent = event.data.object;
			updatePaymentStatus(paymentIntent.id, "completed");
			break;
		case "refund.updated":
			const refund = event.data.object;
			if (refund.status) {
				if (refund.status === "succeeded") {
					updateRefundStatus(refund, "succeeded");
				} else if (refund.status === "failed") {
					updateRefundStatus(refund, "failed");
				} else if (refund.status === "canceled") {
					updateRefundStatus(refund, "cancelled");
				}
			}
			break;
		case "refund.failed":
			const failedRefund = event.data.object;
			updateRefundStatus(failedRefund, "failed");
			break;

		default:
			console.log(`Unhandled event type ${event.type}`);
	}

	return res.status(200).json({ message: "Stripe webhook received" });
};

const updatePaymentStatus = async (paymentIntentId: string, status: "pending" | "completed" | "cancelled") => {
	try {
		// Stripe can deliver an event more than once; only the first transition notifies anyone.
		const payment = await PaymentModel.findOneAndUpdate(
			{ paymentIntentId, status: { $ne: status } },
			{ $set: { status } },
			{ new: true },
		);
		if (!payment) {
			console.log(`Payment with intent ID ${paymentIntentId} not found or already ${status}.`);
			return;
		}
		const booking = await BookingModel.findById(payment.bookingId);
		if (!booking) {
			console.error(`Booking with ID ${payment.bookingId} not found.`);
			return;
		}
		await sendPaymentSucceededNotification(booking);
		await sendBookingNotification(payment.bookingId, booking);
		console.log(`Payment status updated to ${status} for intent ID ${paymentIntentId}.`);
	} catch (error) {
		console.error(`Error updating payment status for intent ID ${paymentIntentId}:`, error);
	}
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
		console.error(`Error sending payment notification for booking ID ${bookingId}:`, error.response);
	}
};

const sendBookingNotification = async (bookingId: any, booking: InstanceType<typeof BookingModel>) => {
	try {
		// Only approved providers hear about new jobs; anyone else could not open or accept them anyway.
		const availableProviders = await UserModel.find({
			isProviderAvailable: true,
			"roles.Provider": true,
			providerStatus: "approved",
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
			console.log(`No providers available within 25km radius for booking ID ${bookingId}.`);
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
		console.error(
			`Error sending booking notification for booking ID ${bookingId} to available providers:`,
			error.response,
		);
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

	switch (event.type) {
		case "payout.paid":
			const payout = event.data.object;
			updatePayoutStatus(payout.id, "paid");
			break;

		case "payout.failed":
			const failedPayout = event.data.object;
			updatePayoutStatus(failedPayout.id, "failed");
			break;

		case "payout.canceled":
			const canceledPayout = event.data.object;
			updatePayoutStatus(canceledPayout.id, "cancelled");
			break;

		default:
			console.log(`Unhandled event type ${event.type}`);
	}

	return res.status(200).json({ message: "Stripe webhook received" });
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const updatePayoutStatus = async (payoutId: string, status: "paid" | "failed" | "cancelled") => {
	try {
		// The payout record is written just after Stripe creates the payout; give it a moment to exist.
		await delay(5000);
		// One atomic transition per status. Failed and cancelled are final, so a redelivered event can never credit
		// the balance twice.
		const previous = await PayoutModel.findOneAndUpdate(
			{ payoutId, status: { $nin: ["failed", "cancelled", status] } },
			{ $set: { status } },
			{ new: false },
		);
		if (!previous) {
			console.log(`Payout ${payoutId} not found or already ${status}.`);
			return;
		}
		if (status === "failed" || status === "cancelled") {
			await UserModel.updateOne({ _id: previous.userId }, { $inc: { availableBalance: previous.amount } });
		}

		if (status === "paid") {
			await sendPayoutPaidNotification(previous.userId.toString(), previous.amount);
		}
	} catch (error) {
		console.error(`Error updating payout status for payout ID ${payoutId}:`, error);
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
		console.error(`Error sending payout notification for user ID ${userId}:`, error);
	}
};

const updateRefundStatus = async (refund: Stripe.Refund, status: "pending" | "succeeded" | "failed" | "cancelled") => {
	try {
		await delay(5000);
		if (typeof refund.id !== "string" || !refund.id) return;
		const payment = await PaymentModel.findOne({ refundId: refund.id });
		if (!payment) {
			console.error(`Refund with ID ${refund.id} not found.`);
			return;
		}
		// Stripe may redeliver refund.updated; only notify on the first transition to succeeded.
		const alreadySucceeded = payment.refundStatus === "succeeded";
		payment.refundStatus = status;
		payment.refundId = refund.id;
		payment.refundAmount = refund.amount / 100;
		payment.refundCreated = new Date(refund.created * 1000);
		payment.destinationDetails = {
			type: refund.destination_details?.type,
		};
		await payment.save();

		if (status == "succeeded" && !alreadySucceeded) {
			const booking = await BookingModel.findOne({ _id: payment.bookingId });
			if (!booking) {
				console.error(`Booking with ID ${payment.bookingId} not found.`);
				return;
			}
			const user = await UserModel.findOne({ _id: booking.userId });
			if (!user) {
				console.error(`User with ID ${booking.userId} not found.`);
				return;
			}
			await sendRefundEmail(user, payment);
			await sendRefundNotification(String(user._id), booking, payment.refundAmount);
		}
	} catch (error) {
		console.error(`Error updating refund status for refund ID ${refund.id}:`, error);
	}
};

const sendRefundEmail = async (user: InstanceType<typeof UserModel>, payment: InstanceType<typeof PaymentModel>) => {
	try {
		const { error } = await resend.emails.send({
			from: `Helphive <${supportEmail}>`,
			to: [user.email],
			subject: "A Payment was Refunded to your Account",
			react: RefundEmail({
				bookingId: `#${payment.bookingId.toString().slice(-6).toUpperCase()}`,
				refundAmount: payment.refundAmount,
				refundId: `#${payment.refundId.slice(-6).toUpperCase()}`,
				refundCreated: payment.refundCreated || new Date(),
				refundStatus: payment.refundStatus ?? "pending",
				destinationAccountType: payment.destinationDetails.type,
			}),
		});
		if (error) {
			throw new Error(`${error}`);
		}
	} catch (error) {
		console.error(`Error sending refund email for refund:`, error);
	}
};

const sendRefundNotification = async (userId: string, booking: any, refundAmount: number) => {
	const bookingId = booking._id.toString();
	try {
		const title = `${formatMoney(refundAmount)} refunded`;
		const message = `Your ${describeBooking(booking)} booking was cancelled and ${formatMoney(refundAmount)} was refunded to your original payment method.`;
		await sendNotification({
			include_aliases: { external_id: [userId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "BookingDetails", bookingId, type: "payment_refunded" },
		});
		await storeNotification(title, message, userId, "BookingDetails", "payment_refunded", bookingId);
	} catch (error) {
		console.error(`Error sending refund notification for booking ID ${bookingId}:`, error);
	}
};
