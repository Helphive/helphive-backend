// Stripe charge.dispute.* events on the platform endpoint: record the dispute against the payment and booking and
// emit business events. Called from stripe.controller.ts's switch; the other handlers there are untouched.
import type Stripe from "stripe";
import DisputeModel from "../../dal/models/dispute.model";
import PaymentModel from "../../dal/models/payment.model";
import BookingModel from "../../dal/models/booking.model";
import { applyDisputeEvent, type DisputeEventType, type DisputeRecord, type DisputeSnapshot } from "../../lib/disputes";
import { emitEvent } from "../../lib/events";
import log from "../../lib/logger";

const idOf = (value: unknown): string | null =>
	typeof value === "string"
		? value
		: value && typeof value === "object" && "id" in value
			? String((value as any).id)
			: null;

/** The fields recorded from a dispute event (never card or bank details). */
export const disputeSnapshot = (event: Stripe.Event): DisputeSnapshot => {
	const d = event.data.object as Stripe.Dispute;
	return {
		eventId: event.id,
		eventType: event.type as DisputeEventType,
		eventCreated: event.created,
		disputeId: d.id,
		chargeId: idOf(d.charge),
		paymentIntentId: idOf(d.payment_intent),
		amount: d.amount,
		currency: d.currency,
		reason: d.reason,
		status: d.status,
		evidenceDueBy: d.evidence_details?.due_by ?? null,
		isChargeRefundable: !!d.is_charge_refundable,
		livemode: !!d.livemode,
	};
};

const toRecord = (doc: any): DisputeRecord => ({
	disputeId: doc.disputeId,
	chargeId: doc.chargeId ?? null,
	paymentIntentId: doc.paymentIntentId ?? null,
	amount: Math.round(doc.amount * 100),
	currency: doc.currency,
	reason: doc.reason,
	status: doc.status,
	evidenceDueBy: doc.evidenceDueBy ?? null,
	isChargeRefundable: !!doc.isChargeRefundable,
	livemode: !!doc.livemode,
	openedAt: doc.openedAt,
	lastEventAt: doc.lastEventAt,
	fundsWithdrawnAt: doc.fundsWithdrawnAt ?? null,
	fundsReinstatedAt: doc.fundsReinstatedAt ?? null,
	closedAt: doc.closedAt ?? null,
	outcome: doc.outcome ?? null,
	history: (doc.history ?? []).map((h: any) => ({ eventId: h.eventId, type: h.type, at: h.at, status: h.status })),
});

/** Records one dispute event. Safe to repeat (an event id is applied once) and to race (versioned writes, retried). */
export const recordDisputeEvent = async (event: Stripe.Event): Promise<string | void> => {
	const snapshot = disputeSnapshot(event);
	for (let attempt = 0; attempt < 3; attempt++) {
		const existing = await DisputeModel.findOne({ disputeId: snapshot.disputeId }).lean().exec();
		const { record, emit, changed } = applyDisputeEvent(existing ? toRecord(existing) : null, snapshot);
		if (!changed) return "event already applied";

		const payment = record.paymentIntentId
			? await PaymentModel.findOne({ paymentIntentId: record.paymentIntentId }, "_id bookingId").lean().exec()
			: null;
		const booking = payment
			? await BookingModel.findById(payment.bookingId, "_id userId providerId").lean().exec()
			: null;
		const fields = {
			...record,
			amount: record.amount / 100,
			paymentId: payment?._id ?? existing?.paymentId ?? null,
			bookingId: booking?._id ?? existing?.bookingId ?? null,
			userId: booking?.userId ?? existing?.userId ?? null,
			providerId: booking?.providerId ?? existing?.providerId ?? null,
		};
		try {
			if (existing) {
				const updated = await DisputeModel.updateOne(
					{ _id: existing._id, version: existing.version ?? 0 },
					{ $set: { ...fields, version: (existing.version ?? 0) + 1 } },
				);
				if (updated.modifiedCount === 0) continue;
			} else {
				await DisputeModel.create({ ...fields, version: 1 });
			}
		} catch (error: any) {
			// Two first deliveries at once: the other created it; apply this event on top.
			if (error?.code === 11000) continue;
			throw error;
		}

		const subjects = {
			userId: fields.userId,
			providerId: fields.providerId,
			bookingId: fields.bookingId,
			paymentId: fields.paymentId,
		};
		for (const type of emit) {
			emitEvent({
				type: type, // "dispute.created", "dispute.updated", "dispute.funds_withdrawn", "dispute.funds_reinstated", "dispute.closed"
				actor: { type: "system" },
				subjects,
				properties: {
					disputeId: record.disputeId,
					amount: record.amount / 100,
					reason: record.reason,
					status: record.status,
					...(type === "dispute.created" ? { evidenceDueBy: record.evidenceDueBy } : {}),
					...(type === "dispute.closed" ? { outcome: record.outcome } : {}),
				},
			});
		}
		if (!payment) {
			log.warn("dispute_without_payment", "Dispute recorded for a payment intent with no payment record", {
				disputeId: record.disputeId,
			});
			return "payment not found";
		}
		return;
	}
	throw new Error(`Dispute ${snapshot.disputeId} changed concurrently three times; Stripe will redeliver.`);
};
