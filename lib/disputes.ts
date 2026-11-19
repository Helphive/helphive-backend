// Card disputes (chargebacks), the pure part: how each Stripe dispute event changes our record of the dispute and
// which business events it emits. Stripe can deliver events late, twice or out of order; the rules keep the record
// right whatever the order: a closed dispute's outcome is final, an older event never overwrites a newer status, and
// funds withdrawn/reinstated are recorded once each. tests/disputes.test.ts covers the transitions.

export const DISPUTE_EVENT_TYPES = [
	"charge.dispute.created",
	"charge.dispute.updated",
	"charge.dispute.funds_withdrawn",
	"charge.dispute.funds_reinstated",
	"charge.dispute.closed",
] as const;
export type DisputeEventType = (typeof DISPUTE_EVENT_TYPES)[number];

export const isDisputeEventType = (type: string): type is DisputeEventType =>
	(DISPUTE_EVENT_TYPES as readonly string[]).includes(type);

export const DISPUTE_STATUSES = [
	"warning_needs_response",
	"warning_under_review",
	"warning_closed",
	"needs_response",
	"under_review",
	"won",
	"lost",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const FINAL_STATUSES: ReadonlySet<string> = new Set(["won", "lost", "warning_closed"]);
/** Statuses where the platform must still act (submit evidence) before the due date. */
export const NEEDS_RESPONSE: ReadonlySet<string> = new Set(["needs_response", "warning_needs_response"]);

/** What the dispute means for the platform's money once closed. */
export const outcomeOf = (status: string): "won" | "lost" | "warning_closed" | null =>
	status === "won" || status === "lost" || status === "warning_closed" ? status : null;

/** A Stripe dispute reduced to what is recorded (no card or bank details). Amounts in cents, times in seconds. */
export interface DisputeSnapshot {
	eventId: string;
	eventType: DisputeEventType;
	eventCreated: number;
	disputeId: string;
	chargeId: string | null;
	paymentIntentId: string | null;
	amount: number;
	currency: string;
	reason: string;
	status: string;
	evidenceDueBy: number | null;
	isChargeRefundable: boolean;
	livemode: boolean;
	/** Net change of the platform's balance in this event's balance transactions (negative when withdrawn). */
	balanceChange?: number | null;
}

export interface DisputeRecord {
	disputeId: string;
	chargeId: string | null;
	paymentIntentId: string | null;
	amount: number;
	currency: string;
	reason: string;
	status: string;
	evidenceDueBy: Date | null;
	isChargeRefundable: boolean;
	livemode: boolean;
	openedAt: Date;
	lastEventAt: Date;
	fundsWithdrawnAt: Date | null;
	fundsReinstatedAt: Date | null;
	closedAt: Date | null;
	outcome: "won" | "lost" | "warning_closed" | null;
	history: { eventId: string; type: string; at: Date; status: string }[];
}

export type DisputeBusinessEvent =
	| "dispute.created"
	| "dispute.updated"
	| "dispute.funds_withdrawn"
	| "dispute.funds_reinstated"
	| "dispute.closed";

const at = (seconds: number) => new Date(seconds * 1000);

/**
 * The record after `event`, and the business events to emit. `existing` is null for a dispute not seen before (any
 * event type can be the first one we receive). A repeated event id changes nothing and emits nothing.
 */
export const applyDisputeEvent = (
	existing: DisputeRecord | null,
	event: DisputeSnapshot,
): { record: DisputeRecord; emit: DisputeBusinessEvent[]; changed: boolean } => {
	if (existing?.history.some((h) => h.eventId === event.eventId)) {
		return { record: existing, emit: [], changed: false };
	}
	const eventAt = at(event.eventCreated);
	const emit: DisputeBusinessEvent[] = [];
	const base: DisputeRecord = existing
		? { ...existing, history: [...existing.history] }
		: {
				disputeId: event.disputeId,
				chargeId: event.chargeId,
				paymentIntentId: event.paymentIntentId,
				amount: event.amount,
				currency: event.currency,
				reason: event.reason,
				status: event.status,
				evidenceDueBy: event.evidenceDueBy ? at(event.evidenceDueBy) : null,
				isChargeRefundable: event.isChargeRefundable,
				livemode: event.livemode,
				openedAt: eventAt,
				lastEventAt: new Date(0),
				fundsWithdrawnAt: null,
				fundsReinstatedAt: null,
				closedAt: null,
				outcome: null,
				history: [],
			};
	if (!existing) emit.push("dispute.created");

	const newer = eventAt.getTime() >= base.lastEventAt.getTime();
	const wasFinal = FINAL_STATUSES.has(base.status);
	const detailsOf = (r: DisputeRecord) =>
		JSON.stringify([r.status, r.amount, r.reason, r.evidenceDueBy?.getTime() ?? null]);
	const previousDetails = detailsOf(base);
	// Only a newer event updates the details; a final outcome is never replaced by an earlier, open status.
	if (newer && !(wasFinal && !FINAL_STATUSES.has(event.status))) {
		base.status = event.status;
		base.amount = event.amount;
		base.reason = event.reason;
		base.evidenceDueBy = event.evidenceDueBy ? at(event.evidenceDueBy) : base.evidenceDueBy;
		base.isChargeRefundable = event.isChargeRefundable;
		base.chargeId = event.chargeId ?? base.chargeId;
		base.paymentIntentId = event.paymentIntentId ?? base.paymentIntentId;
		base.lastEventAt = eventAt;
	}
	if (event.eventType === "charge.dispute.created" && eventAt < base.openedAt) base.openedAt = eventAt;

	if (event.eventType === "charge.dispute.funds_withdrawn" && !base.fundsWithdrawnAt) {
		base.fundsWithdrawnAt = eventAt;
		emit.push("dispute.funds_withdrawn");
	}
	if (event.eventType === "charge.dispute.funds_reinstated" && !base.fundsReinstatedAt) {
		base.fundsReinstatedAt = eventAt;
		emit.push("dispute.funds_reinstated");
	}
	const outcome = outcomeOf(base.status);
	if (outcome && !base.outcome) {
		base.outcome = outcome;
		base.closedAt = eventAt;
		emit.push("dispute.closed");
	} else if (event.eventType === "charge.dispute.closed" && !base.closedAt) {
		// A closed event whose status is not final yet (should not happen) still marks when Stripe closed it.
		base.closedAt = eventAt;
	}
	if (existing && previousDetails !== detailsOf(base) && !emit.includes("dispute.closed"))
		emit.push("dispute.updated");

	base.history.push({ eventId: event.eventId, type: event.eventType, at: eventAt, status: event.status });
	base.history.sort((a, b) => a.at.getTime() - b.at.getTime());
	return { record: base, emit, changed: true };
};

/** Time left to respond, for the console's deadline: null when no response is due. */
export const responseDeadline = (record: Pick<DisputeRecord, "status" | "evidenceDueBy">, now: Date) => {
	if (!record.evidenceDueBy || !NEEDS_RESPONSE.has(record.status)) return null;
	const msLeft = record.evidenceDueBy.getTime() - now.getTime();
	return {
		dueBy: record.evidenceDueBy,
		msLeft,
		overdue: msLeft <= 0,
		urgency: msLeft <= 0 ? "overdue" : msLeft < 2 * 86_400_000 ? "urgent" : msLeft < 7 * 86_400_000 ? "soon" : "ok",
	};
};

/** Stripe's reason codes in plain words. */
export const DISPUTE_REASONS: Record<string, string> = {
	bank_cannot_process: "The bank cannot process the charge",
	check_returned: "Cheque returned",
	credit_not_processed: "Customer says a promised refund was not made",
	customer_initiated: "Customer asked their bank to reverse it",
	debit_not_authorized: "Debit not authorised",
	duplicate: "Customer says they were charged twice",
	fraudulent: "Customer says they did not make the payment",
	general: "General dispute",
	incorrect_account_details: "Incorrect account details",
	insufficient_funds: "Insufficient funds",
	product_not_received: "Customer says the service was not provided",
	product_unacceptable: "Customer says the service was unacceptable",
	subscription_canceled: "Customer says they cancelled",
	unrecognized: "Customer does not recognise the payment",
};
