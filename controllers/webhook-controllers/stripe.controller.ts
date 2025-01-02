import { Request, Response } from "express";
import { Resend } from "resend";
import stripe from "../service-accounts/stripe";
import { sendNotification } from "../service-accounts/onesignal";
import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import PayoutModel from "../../dal/models/payout.model";
import { SUPPORT_EMAIL } from "../../config/config";
import Stripe from "stripe";
import RefundEmail from "../../emails/refundEmail";

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const connectedEndpointSecret = process.env.STRIPE_CONNECTED_WEBHOOK_SECRET || "";
const resend = new Resend(process.env.RESEND_API_KEY);
const supportEmail = SUPPORT_EMAIL || "";

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const updatePayoutStatus = async (payoutId: string, status: "paid" | "failed" | "cancelled") => {
	try {
		await delay(5000);
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

const updateRefundStatus = async (refund: Stripe.Refund, status: "pending" | "succeeded" | "failed" | "cancelled") => {
	try {
		await delay(5000);
		const payment = await PaymentModel.findOne({ refundId: refund.id });
		if (!payment) {
			console.error(`Refund with ID ${refund.id} not found.`);
			return;
		}
		payment.refundStatus = status;
		payment.refundId = refund.id;
		payment.refundAmount = refund.amount / 100;
		payment.refundCreated = new Date(refund.created * 1000);
		payment.destinationDetails = {
			type: refund.destination_details?.type,
		};
		await payment.save();

		if (status == "succeeded") {
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
			await sendRefundNotification(user._id as string, booking._id as string, payment.refundAmount);
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
				refundStatus: payment.refundStatus,
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

const sendRefundNotification = async (userId: string, bookingId: string, refundAmount: number) => {
	try {
		const notificationMessage = {
			include_aliases: { external_id: [userId] },
			contents: { en: `We're sorry. A booking was cancelled.` },
			headings: { en: `$${refundAmount} Refunded! 👉👈` },
			data: {
				screen: "BookingDetails",
				bookingId,
			},
		};
		sendNotification(notificationMessage);
	} catch (error) {
		console.error(`Error sending refund notification for refund ID: `, error);
	}
};
