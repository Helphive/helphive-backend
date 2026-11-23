// Stripe's own risk assessment of each charge (Radar outcome: type, risk level, risk score when the account gets one)
// and the card fingerprint, recorded when a payment succeeds or fails. Called from the Stripe webhook handler without
// awaiting: it fetches the charge from Stripe, stores it in riskcharges and asks the engine to evaluate the customer.
// It never throws and never changes what the webhook does.
import type Stripe from "stripe";
import mongoose from "mongoose";
import PaymentModel from "../../dal/models/payment.model";
import BookingModel from "../../dal/models/booking.model";
import { RiskChargeModel } from "../../dal/models/risk.model";
import log from "../logger";

const chargeIdOf = (intent: Stripe.PaymentIntent, status: "succeeded" | "failed"): string | null => {
	const id = status === "succeeded" ? intent.latest_charge : intent.last_payment_error?.charge;
	if (!id) return null;
	return typeof id === "string" ? id : ((id as { id?: string }).id ?? null);
};

/** The stored assessment from a Stripe charge. Pure; exported for tests. */
export const assessmentFromCharge = (charge: Partial<Stripe.Charge>) => {
	const card = charge.payment_method_details?.card;
	return {
		outcome: {
			type: charge.outcome?.type ?? null,
			riskLevel: charge.outcome?.risk_level ?? null,
			riskScore: typeof charge.outcome?.risk_score === "number" ? charge.outcome.risk_score : null,
			networkStatus: charge.outcome?.network_status ?? null,
			reason: charge.outcome?.reason ?? null,
			sellerMessage: charge.outcome?.seller_message ?? null,
		},
		card: {
			fingerprint: card?.fingerprint ?? null,
			brand: card?.brand ?? null,
			last4: card?.last4 ?? null,
			country: card?.country ?? null,
			funding: card?.funding ?? null,
		},
	};
};

export const recordChargeAssessment = async (intent: Stripe.PaymentIntent, status: "succeeded" | "failed") => {
	try {
		const chargeId = chargeIdOf(intent, status);
		if (!chargeId) return;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const stripe = require("../../controllers/service-accounts/stripe").default as Stripe;
		const charge = await stripe.charges.retrieve(chargeId);
		const payment: any = await PaymentModel.findOne({ paymentIntentId: intent.id }, "_id bookingId").lean().exec();
		const bookingId = payment?.bookingId ?? intent.metadata?.bookingId ?? null;
		const booking: any =
			bookingId && mongoose.isValidObjectId(bookingId)
				? await BookingModel.findById(bookingId, "userId").lean().exec()
				: null;
		await RiskChargeModel.updateOne(
			{ chargeId },
			{
				$set: {
					paymentIntentId: intent.id,
					paymentId: payment?._id ?? null,
					bookingId: booking?._id ?? null,
					userId: booking?.userId ?? null,
					status,
					at: new Date((charge.created ?? Math.floor(Date.now() / 1000)) * 1000),
					...assessmentFromCharge(charge),
				},
			},
			{ upsert: true },
		).exec();
		if (booking?.userId) {
			const { scheduleEvaluation } = await import("./engine");
			scheduleEvaluation([String(booking.userId)], { type: `charge.${status}` });
		}
	} catch (error) {
		log.error("risk_record_stripe_failed", "Risk: could not record Stripe's assessment of a charge", error);
	}
};
