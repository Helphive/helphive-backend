// Card disputes: how each Stripe event changes the record (in order, repeated, out of order) and which business events
// it emits; the response deadline. Pure.
import test from "node:test";
import assert from "node:assert/strict";
import { applyDisputeEvent, responseDeadline, type DisputeRecord, type DisputeSnapshot } from "../lib/disputes";
import { disputeSnapshot } from "../controllers/webhook-controllers/disputes.webhook";

const T0 = 1_763_500_000; // seconds
const DUE = T0 + 7 * 86400;

const ev = (
	n: number,
	type: DisputeSnapshot["eventType"],
	status: string,
	extra: Partial<DisputeSnapshot> = {},
): DisputeSnapshot => ({
	eventId: `evt_${n}`,
	eventType: type,
	eventCreated: T0 + n * 60,
	disputeId: "dp_1",
	chargeId: "ch_1",
	paymentIntentId: "pi_1",
	amount: 8000,
	currency: "usd",
	reason: "fraudulent",
	status,
	evidenceDueBy: DUE,
	isChargeRefundable: false,
	livemode: false,
	...extra,
});

const run = (events: DisputeSnapshot[]) => {
	let record: DisputeRecord | null = null;
	const emitted: string[] = [];
	for (const e of events) {
		const result = applyDisputeEvent(record, e);
		record = result.record;
		emitted.push(...result.emit);
	}
	return { record: record!, emitted };
};

test("the usual life of a lost dispute: created, funds withdrawn, under review, closed lost", () => {
	const { record, emitted } = run([
		ev(1, "charge.dispute.created", "needs_response"),
		ev(2, "charge.dispute.funds_withdrawn", "needs_response"),
		ev(3, "charge.dispute.updated", "under_review"),
		ev(4, "charge.dispute.closed", "lost"),
	]);
	assert.deepEqual(emitted, ["dispute.created", "dispute.funds_withdrawn", "dispute.updated", "dispute.closed"]);
	assert.equal(record.status, "lost");
	assert.equal(record.outcome, "lost");
	assert.equal(record.closedAt!.getTime(), (T0 + 240) * 1000);
	assert.equal(record.fundsWithdrawnAt!.getTime(), (T0 + 120) * 1000);
	assert.equal(record.evidenceDueBy!.getTime(), DUE * 1000);
	assert.equal(record.history.length, 4);
});

test("a won dispute gets its funds reinstated", () => {
	const { record, emitted } = run([
		ev(1, "charge.dispute.created", "needs_response"),
		ev(2, "charge.dispute.funds_withdrawn", "needs_response"),
		ev(3, "charge.dispute.updated", "under_review"),
		ev(4, "charge.dispute.funds_reinstated", "won"),
		ev(5, "charge.dispute.closed", "won"),
	]);
	assert.equal(record.outcome, "won");
	assert.ok(record.fundsReinstatedAt);
	assert.deepEqual(emitted, [
		"dispute.created",
		"dispute.funds_withdrawn",
		"dispute.updated",
		"dispute.funds_reinstated",
		"dispute.closed",
	]);
});

test("a repeated event changes nothing and emits nothing", () => {
	const first = applyDisputeEvent(null, ev(1, "charge.dispute.created", "needs_response"));
	const again = applyDisputeEvent(first.record, ev(1, "charge.dispute.created", "needs_response"));
	assert.equal(again.changed, false);
	assert.deepEqual(again.emit, []);
	assert.equal(again.record, first.record);
});

test("out of order: the closed event first, then the late created and updated ones never reopen it", () => {
	const { record, emitted } = run([
		ev(4, "charge.dispute.closed", "lost"),
		ev(1, "charge.dispute.created", "needs_response"),
		ev(3, "charge.dispute.updated", "under_review"),
	]);
	assert.equal(record.status, "lost");
	assert.equal(record.outcome, "lost");
	assert.equal(record.openedAt.getTime(), (T0 + 60) * 1000, "opened when Stripe created it");
	assert.equal(emitted.filter((e) => e === "dispute.created").length, 1);
	assert.equal(emitted.filter((e) => e === "dispute.closed").length, 1);
	assert.deepEqual(
		record.history.map((h) => h.eventId),
		["evt_1", "evt_3", "evt_4"],
		"history in time order",
	);
});

test("an older update never overwrites a newer status", () => {
	const { record } = run([
		ev(1, "charge.dispute.created", "needs_response"),
		ev(5, "charge.dispute.updated", "under_review"),
		ev(3, "charge.dispute.updated", "needs_response"),
	]);
	assert.equal(record.status, "under_review");
});

test("funds withdrawn twice (two events) is recorded once", () => {
	const { record, emitted } = run([
		ev(1, "charge.dispute.created", "needs_response"),
		ev(2, "charge.dispute.funds_withdrawn", "needs_response"),
		ev(3, "charge.dispute.funds_withdrawn", "needs_response"),
	]);
	assert.equal(emitted.filter((e) => e === "dispute.funds_withdrawn").length, 1);
	assert.equal(record.fundsWithdrawnAt!.getTime(), (T0 + 120) * 1000);
});

test("an inquiry (warning) closes as warning_closed", () => {
	const { record, emitted } = run([
		ev(1, "charge.dispute.created", "warning_needs_response"),
		ev(2, "charge.dispute.closed", "warning_closed"),
	]);
	assert.equal(record.outcome, "warning_closed");
	assert.deepEqual(emitted, ["dispute.created", "dispute.closed"]);
});

test("an update with a new amount or deadline is applied", () => {
	const { record, emitted } = run([
		ev(1, "charge.dispute.created", "needs_response"),
		ev(2, "charge.dispute.updated", "needs_response", { amount: 5000, evidenceDueBy: DUE + 86400 }),
	]);
	assert.equal(record.amount, 5000);
	assert.equal(record.evidenceDueBy!.getTime(), (DUE + 86400) * 1000);
	assert.deepEqual(emitted, ["dispute.created", "dispute.updated"]);
});

test("the response deadline: urgency, and none once a response is not needed", () => {
	const due = new Date(DUE * 1000);
	assert.equal(
		responseDeadline({ status: "needs_response", evidenceDueBy: due }, new Date(due.getTime() - 10 * 86400_000))!
			.urgency,
		"ok",
	);
	assert.equal(
		responseDeadline({ status: "needs_response", evidenceDueBy: due }, new Date(due.getTime() - 3 * 86400_000))!
			.urgency,
		"soon",
	);
	assert.equal(
		responseDeadline({ status: "needs_response", evidenceDueBy: due }, new Date(due.getTime() - 3600_000))!.urgency,
		"urgent",
	);
	const overdue = responseDeadline(
		{ status: "warning_needs_response", evidenceDueBy: due },
		new Date(due.getTime() + 1),
	)!;
	assert.equal(overdue.overdue, true);
	assert.equal(responseDeadline({ status: "under_review", evidenceDueBy: due }, new Date()), null);
	assert.equal(responseDeadline({ status: "needs_response", evidenceDueBy: null }, new Date()), null);
});

test("the webhook keeps only ids, amounts, statuses and dates from Stripe's dispute (no card or bank details)", () => {
	const snapshot = disputeSnapshot({
		id: "evt_9",
		type: "charge.dispute.created",
		created: T0,
		data: {
			object: {
				id: "dp_9",
				charge: "ch_9",
				payment_intent: { id: "pi_9" },
				amount: 1234,
				currency: "usd",
				reason: "duplicate",
				status: "needs_response",
				evidence_details: { due_by: DUE },
				is_charge_refundable: true,
				livemode: false,
				evidence: { customer_email_address: "x@y.com", billing_address: "1 Road" },
				payment_method_details: { card: { last4: "4242", brand: "visa" } },
			},
		},
	} as any);
	assert.equal(snapshot.paymentIntentId, "pi_9");
	assert.equal(snapshot.amount, 1234);
	assert.doesNotMatch(JSON.stringify(snapshot), /4242|x@y\.com|1 Road|visa/);
});
