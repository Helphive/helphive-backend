// Reconciliation with Stripe: the matcher on fixture Stripe objects and database records (every mismatch type), the
// fee and money-summary arithmetic, range parsing, and safe pagination. Pure; no network, no database.
import test from "node:test";
import assert from "node:assert/strict";
import {
	expectedFeeCents,
	owedVersusHeld,
	parseRange,
	reconcile,
	refundedCentsOf,
	stripeTotals,
	summariseMoney,
	type ReconciliationInput,
} from "../lib/reconciliation";
import { listAll, StripeDeadlineError, toIntent, toTransfer } from "../lib/stripeReads";
import { platformFeeOf } from "../lib/operations";
import { setLogSink } from "../lib/logger";

setLogSink(() => undefined);

const pid = (n: number) => `6740a1b2c3d4e5f6000000${String(n).padStart(2, "0")}`;
const bid = (n: number) => `6740a1b2c3d4e5f6100000${String(n).padStart(2, "0")}`;

/** A clean period: two paid bookings, one refunded in part, one released earning with its transfer, one paid payout. */
const clean = (): ReconciliationInput => ({
	stripe: {
		paymentIntents: [
			{
				id: "pi_1",
				amount: 8000,
				amountReceived: 8000,
				status: "succeeded",
				created: 1,
				bookingId: bid(1),
				charge: { id: "ch_1", amount: 8000, amountRefunded: 0, status: "succeeded", disputed: false },
			},
			{
				id: "pi_2",
				amount: 4000,
				amountReceived: 4000,
				status: "succeeded",
				created: 2,
				bookingId: bid(2),
				charge: { id: "ch_2", amount: 4000, amountRefunded: 1500, status: "succeeded", disputed: false },
			},
		],
		refunds: [{ id: "re_2", amount: 1500, status: "succeeded", paymentIntentId: "pi_2", created: 3 }],
		transfers: [{ id: "tr_1", amount: 7600, amountReversed: 0, destination: "acct_1", created: 4 }],
		payouts: [{ id: "po_1", amount: 7600, status: "paid", account: "acct_1", created: 5 }],
	},
	db: {
		payments: [
			{ _id: pid(1), bookingId: bid(1), amount: 80, status: "completed", paymentIntentId: "pi_1" },
			{
				_id: pid(2),
				bookingId: bid(2),
				amount: 40,
				status: "completed",
				paymentIntentId: "pi_2",
				refundId: "re_2",
				refundStatus: "succeeded",
				refundAmount: 15,
			},
		],
		earnings: [{ _id: "e1", bookingId: bid(1), amount: 76, status: "completed", transferId: "tr_1" }],
		payouts: [{ _id: "p1", payoutId: "po_1", amount: 76, status: "paid", destinationAccount: "acct_1" }],
	},
	defaultFeePercent: 5,
});

const kinds = (input: ReconciliationInput) =>
	reconcile(input)
		.mismatches.map((m) => `${m.category}:${m.type}:${m.stripe?.id ?? "-"}:${m.db?.id ?? "-"}`)
		.sort();

test("a period where everything agrees has no mismatches", () => {
	const result = reconcile(clean());
	assert.deepEqual(result.mismatches, []);
	assert.equal(result.counts.total, 0);
	assert.deepEqual(result.checked.stripe, { paymentIntents: 2, refunds: 1, transfers: 1, payouts: 1 });
});

test("missing in the database: a payment intent, a refund, a transfer and a payout with no record", () => {
	const input = clean();
	input.stripe.paymentIntents.push({
		id: "pi_9",
		amount: 2000,
		amountReceived: 2000,
		status: "succeeded",
		created: 9,
		bookingId: bid(9),
		charge: null,
	});
	input.stripe.refunds.push({ id: "re_9", amount: 500, status: "succeeded", paymentIntentId: "pi_1", created: 9 });
	input.stripe.transfers.push({ id: "tr_9", amount: 100, amountReversed: 0, destination: "acct_2", created: 9 });
	input.stripe.payouts.push({ id: "po_9", amount: 100, status: "paid", account: "acct_2", created: 9 });
	const found = kinds(input);
	assert.ok(found.includes("payment:missing_in_db:pi_9:-"));
	assert.ok(found.includes(`refund:missing_in_db:re_9:${pid(1)}`), "a refund on a known payment links to it");
	assert.ok(found.includes("transfer:missing_in_db:tr_9:-"));
	assert.ok(found.includes("payout:missing_in_db:po_9:-"));
	assert.equal(found.length, 4);
});

test("missing in Stripe: a completed payment, a refund, an earning's transfer and a payout Stripe did not return", () => {
	const input = clean();
	input.db.payments.push({
		_id: pid(3),
		bookingId: bid(3),
		amount: 20,
		status: "completed",
		paymentIntentId: "pi_gone",
	});
	input.db.payments[0].refunds = [{ refundId: "re_gone", amount: 10, status: "succeeded" }];
	input.db.earnings.push({ _id: "e2", bookingId: bid(2), amount: 38, status: "completed", transferId: "tr_gone" });
	input.db.earnings.push({ _id: "e3", bookingId: bid(3), amount: 19, status: "completed", transferId: null });
	input.db.payouts.push({ _id: "p2", payoutId: "po_gone", amount: 5, status: "paid", destinationAccount: "acct_1" });
	const found = kinds(input);
	assert.ok(found.includes(`payment:missing_in_stripe:-:${pid(3)}`));
	assert.ok(found.includes(`refund:missing_in_stripe:re_gone:${pid(1)}`));
	assert.ok(found.includes("transfer:missing_in_stripe:tr_gone:e2"));
	assert.ok(found.includes("transfer:missing_in_stripe:-:e3"), "released with no transfer id");
	assert.ok(found.includes("payout:missing_in_stripe:po_gone:p2"));
});

test("a pending payment or a context-only record is never reported missing in Stripe", () => {
	const input = clean();
	input.db.payments.push({
		_id: pid(4),
		bookingId: bid(4),
		amount: 20,
		status: "pending",
		paymentIntentId: "pi_unlisted",
	});
	input.db.payments.push({
		_id: pid(5),
		bookingId: bid(5),
		amount: 20,
		status: "completed",
		paymentIntentId: "pi_old",
		refundId: "re_old",
		refundStatus: "succeeded",
		refundAmount: 20,
		contextOnly: true,
	});
	assert.deepEqual(reconcile(input).mismatches, []);
});

test("amount differs: payment, refund, transfer, payout and the charge's refunded total", () => {
	const input = clean();
	input.db.payments[0].amount = 79.99;
	input.db.payments[1].refundAmount = 14;
	input.db.earnings[0].amount = 76.01;
	input.db.payouts[0].amount = 70;
	const result = reconcile(input);
	const found = result.mismatches.map((m) => `${m.category}:${m.type}`);
	assert.ok(found.includes("payment:amount_differs"));
	assert.ok(found.includes("refund:amount_differs"));
	assert.ok(found.includes("transfer:amount_differs"));
	assert.ok(found.includes("payout:amount_differs"));
	assert.ok(found.includes("charge:amount_differs"), "Stripe refunded $15, the record says $14 succeeded");
	const payout = result.mismatches.find((m) => m.category === "payout")!;
	assert.equal(payout.difference, 6, "Stripe minus database, in dollars");
	assert.equal(payout.stripe!.amount, 76);
	assert.equal(payout.db!.amount, 70);
});

test("status differs: payment, refund, payout, and a reversed transfer", () => {
	const input = clean();
	input.db.payments[0].status = "pending";
	input.db.payments[1].refundStatus = "pending";
	input.db.payouts[0].status = "pending";
	input.stripe.transfers[0].amountReversed = 7600;
	const found = kinds(input);
	assert.ok(found.includes(`payment:status_differs:pi_1:${pid(1)}`));
	assert.ok(found.includes(`refund:status_differs:re_2:${pid(2)}`));
	assert.ok(found.includes("payout:status_differs:po_1:p1"));
	assert.ok(found.includes("transfer:status_differs:tr_1:e1"));
	const reversed = reconcile(input).mismatches.find((m) => m.category === "transfer")!;
	assert.equal(reversed.stripe!.status, "reversed");
});

test("Stripe's spellings map to ours: canceled is cancelled, in_transit is pending, requested is pending", () => {
	const input = clean();
	input.stripe.payouts[0].status = "in_transit";
	input.db.payouts[0].status = "pending";
	input.stripe.refunds[0].status = "canceled";
	input.db.payments[1].refundStatus = "cancelled";
	input.stripe.paymentIntents[1].charge!.amountRefunded = 0;
	assert.deepEqual(reconcile(input).mismatches, []);
	input.stripe.paymentIntents[0].status = "requires_payment_method";
	input.stripe.paymentIntents[0].charge = null;
	input.db.payments[0].status = "pending";
	input.db.earnings = [];
	input.stripe.transfers = [];
	assert.deepEqual(reconcile(input).mismatches, [], "an unpaid intent and a pending payment agree");
});

test("duplicates: two records for one intent, two succeeded intents for one booking, one transfer on two earnings, one payout id twice", () => {
	const input = clean();
	input.db.payments.push({
		_id: pid(6),
		bookingId: bid(1),
		amount: 80,
		status: "completed",
		paymentIntentId: "pi_1",
	});
	input.stripe.paymentIntents.push({
		id: "pi_1b",
		amount: 8000,
		amountReceived: 8000,
		status: "succeeded",
		created: 6,
		bookingId: bid(1),
		charge: null,
	});
	input.db.earnings.push({ _id: "e9", bookingId: bid(2), amount: 76, status: "completed", transferId: "tr_1" });
	input.db.payouts.push({ _id: "p9", payoutId: "po_1", amount: 76, status: "paid" });
	const result = reconcile(input);
	const dupes = result.mismatches
		.filter((m) => m.type === "duplicate")
		.map((m) => `${m.category}:${m.stripe?.id ?? "-"}:${m.db?.id ?? "-"}`);
	assert.ok(dupes.includes(`payment:pi_1:${pid(1)}`));
	assert.ok(dupes.includes(`payment:pi_1:${pid(6)}`));
	assert.ok(dupes.includes("payment:pi_1b:-"), "the second charge for the booking");
	assert.ok(dupes.includes("transfer:-:e1") && dupes.includes("transfer:-:e9"));
	assert.ok(dupes.includes("payout:-:p1") && dupes.includes("payout:-:p9"));
	assert.equal(result.counts.byType.duplicate, dupes.length);
});

test("the platform fee: charge minus transfer against the system's fee (5 % by default, or the earning's own)", () => {
	assert.equal(expectedFeeCents(80, 5), 400);
	assert.equal(expectedFeeCents(33.33, 5), toCentsFee(33.33));
	// Same arithmetic as the operations module's fee for every amount at 5 %.
	for (const paid of [20, 33.33, 47.5, 80, 123.45, 2000])
		assert.equal(expectedFeeCents(paid, 5) / 100, platformFeeOf(paid));

	const input = clean();
	input.stripe.transfers[0].amount = 7700;
	input.db.earnings[0].amount = 77;
	const fee = reconcile(input).mismatches.find((m) => m.category === "fee")!;
	assert.equal(fee.type, "amount_differs");
	assert.equal(fee.stripe!.amount, 3, "kept $3.00");
	assert.equal(fee.db!.amount, 4, "should have kept $4.00");

	const ownFee = clean();
	ownFee.stripe.transfers[0].amount = 7200;
	ownFee.db.earnings[0] = { ...ownFee.db.earnings[0], amount: 72, feePercent: 10 };
	assert.deepEqual(reconcile(ownFee).mismatches, [], "an earning created at 10 % is checked at 10 %");
});

const toCentsFee = (paid: number) => Math.round(paid * 100) - Math.round(paid * 0.95 * 100);

test("refunded totals count admin refunds and the cancellation refund once each", () => {
	assert.equal(
		refundedCentsOf({
			_id: "x",
			bookingId: "b",
			amount: 80,
			status: "completed",
			refundId: "re_a",
			refundStatus: "succeeded",
			refundAmount: 80,
		}),
		8000,
	);
	assert.equal(
		refundedCentsOf({
			_id: "x",
			bookingId: "b",
			amount: 80,
			status: "completed",
			refundId: "re_b",
			refundStatus: "succeeded",
			refundAmount: 50,
			refunds: [
				{ refundId: "re_a", amount: 30, status: "succeeded" },
				{ refundId: "re_b", amount: 20, status: "succeeded" },
				{ refundId: "re_c", amount: 5, status: "failed" },
			],
		}),
		5000,
	);
});

test("Stripe totals for a run", () => {
	const totals = stripeTotals({
		...clean().stripe,
		transfers: [{ id: "tr", amount: 1000, amountReversed: 250, destination: null, created: 1 }],
	});
	assert.deepEqual(totals, { paid: 120, refunded: 15, transferred: 7.5, paidOut: 76 });
});

test("money summary: gross paid, refunds, fees, released, payouts paid and failed, all in range", () => {
	const r = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-12-01T00:00:00Z") };
	const inside = new Date("2026-11-10T00:00:00Z");
	const outside = new Date("2026-10-10T00:00:00Z");
	const summary = summariseMoney({
		payments: [
			{ amount: 80, status: "completed", paidAt: inside, createdAt: inside, bookingId: "b1" },
			{
				amount: 40,
				status: "completed",
				paidAt: outside,
				createdAt: outside,
				bookingId: "b2",
				refundId: "re",
				refundStatus: "succeeded",
				refundAmount: 40,
				refundCreated: inside,
			},
			{
				amount: 25.5,
				status: "completed",
				createdAt: inside,
				bookingId: "b3",
				refunds: [
					{ refundId: "re1", amount: 5.25, status: "succeeded", createdAt: inside },
					{ refundId: "re2", amount: 1, status: "failed", createdAt: inside },
				],
			},
			{ amount: 99, status: "pending", createdAt: inside, bookingId: "b4" },
		],
		earningsCreated: [
			{ amount: 76, bookingId: "b1" },
			{ amount: 19, bookingId: "bX" },
		],
		earningsReleased: [{ amount: 76 }, { amount: 0.95 }],
		paidByBooking: new Map([["b1", 80]]),
		payouts: [
			{ amount: 50, status: "paid", paidAt: inside, createdAt: outside },
			{ amount: 10, status: "failed", failedAt: inside, createdAt: inside },
			{ amount: 7, status: "cancelled", createdAt: inside },
			{ amount: 999, status: "paid", paidAt: outside, createdAt: outside },
		],
		range: r,
		defaultFeePercent: 5,
	});
	assert.deepEqual(summary.grossPaid, { amount: 105.5, count: 2 });
	assert.deepEqual(summary.refunds, { amount: 45.25, count: 2 });
	assert.equal(summary.netPaid, 60.25);
	assert.deepEqual(
		summary.platformFees,
		{ amount: 5, count: 2 },
		"$4 from the payment, $1 implied by a $19 earning at 5 %",
	);
	assert.deepEqual(summary.earningsReleased, { amount: 76.95, count: 2 });
	assert.deepEqual(summary.payoutsPaid, { amount: 50, count: 1 });
	assert.deepEqual(summary.payoutsFailed, { amount: 17, count: 2 });
});

test("owed versus held: coverage is the available balance minus earnings awaiting release", () => {
	const owed = owedVersusHeld({
		pendingEarnings: 76.1,
		providerBalances: 152,
		platformBalance: { available: 50, pending: 300 },
	});
	assert.equal(owed.earningsAwaitingRelease, 76.1);
	assert.equal(owed.coverage, -26.1);
	assert.equal(owedVersusHeld({ pendingEarnings: 1, providerBalances: 0, platformBalance: null }).coverage, null);
});

test("ranges: dates or ISO times, from before to, at most the maximum, never in the future", () => {
	const now = new Date("2026-11-19T12:00:00Z");
	const ok = parseRange("2026-11-01", "2026-11-18", 31, now);
	assert.ok(ok.ok);
	assert.equal(ok.ok && ok.to.toISOString(), "2026-11-19T00:00:00.000Z", "a date-only to includes that day");
	const clamped = parseRange("2026-11-10", "2026-11-30", 31, now);
	assert.equal(clamped.ok && clamped.to.toISOString(), now.toISOString());
	assert.equal(parseRange("2026-11-10", undefined, 31, now).ok, true, "to defaults to now");
	assert.equal(parseRange(undefined, "2026-11-10", 31, now).ok, false);
	assert.equal(parseRange("nonsense", "2026-11-10", 31, now).ok, false);
	assert.equal(parseRange("2026-11-10", "2026-11-01", 31, now).ok, false);
	assert.equal(parseRange("2026-01-01", "2026-11-01", 31, now).ok, false);
	assert.equal(parseRange("2026-12-01", undefined, 31, now).ok, false, "a range wholly in the future");
});

test("pagination follows has_more with starting_after, stops at the cap with a note, and gives up at the deadline", async () => {
	const all = Array.from({ length: 250 }, (_, i) => ({ id: `obj_${i}` }));
	const calls: (string | undefined)[] = [];
	const fetchPage = async (after: string | undefined) => {
		calls.push(after);
		const start = after ? all.findIndex((o) => o.id === after) + 1 : 0;
		return { data: all.slice(start, start + 100), has_more: start + 100 < all.length };
	};
	const notes: string[] = [];
	const got = await listAll("things", fetchPage, { deadline: Infinity, notes });
	assert.equal(got.length, 250);
	assert.deepEqual(calls, [undefined, "obj_99", "obj_199"]);
	assert.deepEqual(notes, []);

	const capped = await listAll("things", fetchPage, { deadline: Infinity, notes }, 150);
	assert.equal(capped.length, 200);
	assert.match(notes[0], /Only the first 150 things/);

	let clock = 0;
	await assert.rejects(
		listAll("things", async (after) => ((clock += 1000), fetchPage(after)), {
			deadline: 1500,
			now: () => clock,
			notes: [],
		}),
		StripeDeadlineError,
	);
});

test("Stripe objects are reduced to ids, amounts and statuses only (no card or bank details kept)", () => {
	const intent = toIntent({
		id: "pi_x",
		amount: 100,
		amount_received: 100,
		status: "succeeded",
		created: 1,
		metadata: { bookingId: bid(1) },
		latest_charge: {
			id: "ch_x",
			amount: 100,
			amount_refunded: 0,
			status: "succeeded",
			disputed: false,
			payment_method_details: { card: { last4: "4242" } },
			billing_details: { email: "a@b.com" },
		},
	} as any);
	assert.doesNotMatch(JSON.stringify(intent), /4242|a@b\.com|billing|payment_method/);
	const transfer = toTransfer({
		id: "tr_x",
		amount: 5,
		amount_reversed: 0,
		destination: { id: "acct_x", email: "p@q.com" },
		created: 1,
	} as any);
	assert.deepEqual(transfer, { id: "tr_x", amount: 5, amountReversed: 0, destination: "acct_x", created: 1 });
});
