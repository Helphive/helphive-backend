// Which recorded webhook events and task runs may be replayed from the console. Only handlers that are safe to run
// again (each makes one conditional state transition, so a second run changes nothing) are offered. Pure.

/** Stripe event types whose handlers are idempotent, with what a replay does. */
export const REPLAYABLE_STRIPE_TYPES: Record<string, string> = {
	"payment_intent.succeeded":
		"Marks the payment completed if it is not already, then sends the booking notifications that a first success sends.",
	"refund.updated":
		"Sets the refund's status from Stripe; notifies the customer only on the first change to succeeded.",
	"refund.failed": "Marks the refund failed if it is not already.",
	"payout.paid": "Marks the payout paid if it is not already, and notifies the provider on that first change.",
	"payout.failed": "Marks the payout failed and returns the amount to the provider's balance, once.",
	"payout.canceled": "Marks the payout cancelled and returns the amount to the provider's balance, once.",
};

/** Why other handled types are not offered. */
export const NOT_REPLAYABLE_STRIPE_TYPES: Record<string, string> = {
	"payment_intent.payment_failed":
		"Only records a payment.failed event; replaying it would record the failure twice.",
};

export const REPLAYABLE_TASKS: Record<string, string> = {
	"earning-complete":
		"Releases the provider's earning if it is still pending: one Stripe transfer (same idempotency key as the original run) and the balance credit, once.",
	"booking-expired":
		"Cancels the booking if it is still pending with no provider, notifies the customer and refunds any payment, once.",
};

/** Stripe keeps events for 30 days; a day of margin so a replay never races the deletion. */
export const STRIPE_EVENT_RETENTION_MS = 29 * 24 * 60 * 60 * 1000;
/** A delivery still "received" after this long never finished (the instance stopped); it may be replayed. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;

export interface Eligibility {
	eligible: boolean;
	reason: string;
	/** What a replay does, when eligible. */
	effect?: string;
}

export interface WebhookRecordLike {
	provider?: string;
	type?: string;
	outcome?: string;
	receivedAt?: Date | string | null;
	eventId?: string;
}

export const webhookReplayEligibility = (record: WebhookRecordLike, now = new Date()): Eligibility => {
	if (record.provider !== "stripe" || !record.eventId)
		return { eligible: false, reason: "Only Stripe events can be replayed." };
	const receivedAt = record.receivedAt ? new Date(record.receivedAt) : null;
	const age = receivedAt ? now.getTime() - receivedAt.getTime() : Infinity;
	const stuck = record.outcome === "received" && age > STUCK_AFTER_MS;
	if (record.outcome !== "failed" && !stuck) {
		return {
			eligible: false,
			reason:
				record.outcome === "received"
					? "This delivery is still being processed."
					: `Only failed deliveries are replayed; this one was ${record.outcome}.`,
		};
	}
	const type = record.type ?? "";
	if (NOT_REPLAYABLE_STRIPE_TYPES[type]) return { eligible: false, reason: NOT_REPLAYABLE_STRIPE_TYPES[type] };
	if (!REPLAYABLE_STRIPE_TYPES[type])
		return { eligible: false, reason: `No handler replays ${type || "this type"}.` };
	if (!(age <= STRIPE_EVENT_RETENTION_MS)) {
		return {
			eligible: false,
			reason: "Stripe keeps events for 30 days and this one is older, so it can no longer be fetched to replay.",
		};
	}
	return {
		eligible: true,
		reason: "Failed, and its handler is safe to run again.",
		effect: REPLAYABLE_STRIPE_TYPES[type],
	};
};

export interface TaskRunLike {
	task?: string;
	outcome?: string;
	bookingId?: string | null;
}

export const taskReplayEligibility = (run: TaskRunLike): Eligibility => {
	if (!run.task || !REPLAYABLE_TASKS[run.task])
		return { eligible: false, reason: `No handler replays ${run.task ?? "this task"}.` };
	if (run.outcome !== "failed" && run.outcome !== "rejected") {
		return { eligible: false, reason: `Only failed or refused runs are replayed; this one was ${run.outcome}.` };
	}
	if (!run.bookingId || !/^[a-f\d]{24}$/i.test(run.bookingId)) {
		return { eligible: false, reason: "The run has no booking id to replay with." };
	}
	return {
		eligible: true,
		reason: "Failed, and its handler is safe to run again.",
		effect: REPLAYABLE_TASKS[run.task],
	};
};
