import { Request, Response } from "express";
import stripe from "../service-accounts/stripe";
import { sendNotification } from "../service-accounts/onesignal";
import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import PayoutModel from "../../dal/models/payout.model";

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const connectedEndpointSecret = process.env.STRIPE_CONNECTED_WEBHOOK_SECRET || "";

export const handleStripeWebhook = async (req: Request, res: Response) => {
	const sig = req.headers["stripe-signature"] || "";
	const body = req.body;

	let event;

	try {
		event = stripe.webhooks.constructEvent(body, sig, endpointSecret);
	} catch (err: any) {
		console.log(`Stripe Webhook signature verification failed:`, err.message);
		return res.status(400).send(`Stripe Webhook Error: ${err.message}`);
	}

	switch (event.type) {
		case "payment_intent.succeeded":
			const paymentIntent = event.data.object;
			updatePaymentStatus(paymentIntent.id, "completed");
			break;

		default:
			console.log(`Unhandled event type ${event.type}`);
	}

	return res.status(200).json({ message: "Stripe webhook received" });
};

const updatePaymentStatus = async (paymentIntentId: string, status: string) => {
	try {
		const payment = await PaymentModel.findOne({ paymentIntentId });
		if (!payment) {
			console.error(`Payment with intent ID ${paymentIntentId} not found.`);
			return;
		}
		payment.status = status;
		await payment.save();
		const booking = await BookingModel.findById(payment.bookingId);
		if (!booking) {
			console.error(`Booking with ID ${payment.bookingId} not found.`);
			return;
		}
		await sendBookingNotification(payment.bookingId);
		console.log(`Payment status updated to ${status} for intent ID ${paymentIntentId}.`);
	} catch (error) {
		console.error(`Error updating payment status for intent ID ${paymentIntentId}:`, error);
	}
};

const sendBookingNotification = async (bookingId: string) => {
	try {
		const availableProviders = await UserModel.find({ isProviderAvailable: true });
		const providerIds = availableProviders.map((provider) => (provider._id as any).toString());

		console.log(providerIds);

		const notificationMessage = {
			include_aliases: { external_id: providerIds },
			contents: { en: `A new job is available near you.` },
			headings: { en: "New Order Received!" },
			data: {
				screen: "AcceptOrder",
				bookingId: bookingId,
			},
		};

		await sendNotification(notificationMessage);
		console.log("Notification sent to ids: ", providerIds);
	} catch (error: any) {
		console.error(
			`Error sending booking notification for booking ID ${bookingId} to available providers:`,
			error.response,
		);
	}
};

export const handleStripeConnectedPayoutsWebhook = async (req: Request, res: Response) => {
	const sig = req.headers["stripe-signature"] || "";
	const body = req.body;

	let event;

	try {
		event = stripe.webhooks.constructEvent(body, sig, connectedEndpointSecret);
	} catch (err: any) {
		console.log(`Stripe Webhook signature verification failed:`, err.message);
		return res.status(400).send(`Stripe Webhook Error: ${err.message}`);
	}

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

const updatePayoutStatus = async (payoutId: string, status: "paid" | "failed" | "cancelled") => {
	try {
		const payout = await PayoutModel.findOne({ payoutId });
		if (!payout) {
			console.error(`Payout with ID ${payoutId} not found.`);
			return;
		}
		payout.status = status;
		if (status == "failed" || status == "cancelled") {
			const user = await UserModel.findOne({ _id: payout.userId });
			if (user) {
				user.availableBalance += payout.amount;
				await user.save();
			}
		}

		await payout.save();
	} catch (error) {
		console.error(`Error updating payout status for payout ID ${payoutId}:`, error);
	}
};
