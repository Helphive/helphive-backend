// Reconciliation with Stripe, the pure part: given the Stripe objects and the database records for a period (both
// already reduced to the few fields compared here, never card or bank details), list every mismatch. The controller
// (controllers/admin/finance.controller.ts) fetches both sides; tests/reconciliation.test.ts covers every type.
//
// How HelpHive moves money (separate charges and transfers): the customer pays the platform the full amount (a
// payment intent and its charge), refunds come back out of that charge, and when a booking completes the provider's
// share is transferred to their connected account (one transfer per earning). Payouts happen on each connected
// account. So the platform's fee in Stripe is "charge amount - transfer amount", compared with the fee the system
// computes from the payment (5 % by default; the fee in force when the earning was created).
import { toCents } from "./operations";

export const MISMATCH_TYPES = [
	"missing_in_db",
	"missing_in_stripe",
	"amount_differs",
	"status_differs",
	"duplicate",
] as const;
export type MismatchType = (typeof MISMATCH_TYPES)[number];

export const MISMATCH_CATEGORIES = ["payment", "charge", "refund", "transfer", "payout", "fee"] as const;
export type MismatchCategory = (typeof MISMATCH_CATEGORIES)[number];

export interface Mismatch {
	key: string;
	category: MismatchCategory;
	type: MismatchType;
	explanation: string;
	stripe: { id: string; amount: number | null; status: string | null; account?: string | null } | null;
	db: { type: "payment" | "earning" | "payout"; id: string; amount: number | null; status: string | null } | null;
	/** Dollars: stripe minus database, when both have an amount. */
	difference: number | null;
	bookingId?: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs (amounts: Stripe in cents, database in dollars, as each stores them)

export interface StripePaymentIntent {
	id: string;
	amount: number;
	amountReceived: number;
	status: string;
	created: number;
	bookingId?: string | null;
	charge?: { id: string; amount: number; amountRefunded: number; status: string; disputed: boolean } | null;
}
export interface StripeRefund {
	id: string;
	amount: number;
	status: string;
	paymentIntentId: string | null;
	created: number;
}
export interface StripeTransfer {
	id: string;
	amount: number;
	amountReversed: number;
	destination: string | null;
	created: number;
}
export interface StripePayout {
	id: string;
	amount: number;
	status: string;
	account: string;
	created: number;
}

export interface DbPayment {
	_id: string;
	bookingId: string;
	amount: number;
	status: string;
	paymentIntentId?: string | null;
	refundId?: string | null;
	refundStatus?: string | null;
	refundAmount?: number | null;
	refunds?: { refundId?: string | null; amount: number; status: string }[] | null;
	/** Loaded only as context (an out-of-range payment of an in-range refund or earning): never reported missing. */
	contextOnly?: boolean;
}
export interface DbEarning {
	_id: string;
	bookingId: string;
	amount: number;
	status: string;
	transferId?: string | null;
	feePercent?: number | null;
}
export interface DbPayout {
	_id: string;
	payoutId: string;
	amount: number;
	status: string;
	destinationAccount?: string | null;
}

export interface ReconciliationInput {
	stripe: {
		paymentIntents: StripePaymentIntent[];
		refunds: StripeRefund[];
		transfers: StripeTransfer[];
		payouts: StripePayout[];
	};
	db: { payments: DbPayment[]; earnings: DbEarning[]; payouts: DbPayout[] };
	/** The fee used for earnings that do not record their own (all earnings before settings existed). */
	defaultFeePercent: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Status mapping

/** The payment status the database should hold for a Stripe payment intent status. */
export const paymentStatusFor = (intentStatus: string) =>
	intentStatus === "succeeded" ? "completed" : intentStatus === "canceled" ? "cancelled" : "pending";

/** Stripe refund status -> the database's ("canceled" is spelled "cancelled"; "requires_action" is pending). */
export const refundStatusFor = (status: string) =>
	status === "canceled" ? "cancelled" : status === "requires_action" ? "pending" : status;

/** Stripe payout status -> the database's (in transit is still pending until paid). */
export const payoutStatusFor = (status: string) =>
	status === "canceled" ? "cancelled" : status === "in_transit" ? "pending" : status;

const dollars = (cents: number) => Math.round(cents) / 100;

/** The platform fee in cents the system computes for a payment at `feePercent` (as operations.platformFeeOf). */
export const expectedFeeCents = (paidDollars: number, feePercent: number) => {
	const paid = toCents(paidDollars);
	return paid - toCents((paidDollars * (100 - feePercent)) / 100);
};

// ---------------------------------------------------------------------------------------------------------------
// The matcher

export const reconcile = (input: ReconciliationInput) => {
	const out: Mismatch[] = [];
	const add = (m: Omit<Mismatch, "key" | "difference"> & { difference?: number | null }) => {
		const key = [m.category, m.type, m.stripe?.id ?? "-", m.db?.id ?? "-"].join(":");
		if (out.some((existing) => existing.key === key)) return;
		const difference =
			m.difference !== undefined
				? m.difference
				: m.stripe?.amount != null && m.db?.amount != null
					? Math.round((m.stripe.amount - m.db.amount) * 100) / 100
					: null;
		out.push({ ...m, key, difference });
	};
	const { stripe, db } = input;

	// Payments <-> payment intents (and their charges).
	const paymentsByIntent = new Map<string, DbPayment[]>();
	for (const p of db.payments) {
		if (!p.paymentIntentId) continue;
		const list = paymentsByIntent.get(p.paymentIntentId) ?? [];
		list.push(p);
		paymentsByIntent.set(p.paymentIntentId, list);
	}
	const intentsById = new Map(stripe.paymentIntents.map((pi) => [pi.id, pi]));
	const dbRef = (p: DbPayment) => ({
		type: "payment" as const,
		id: String(p._id),
		amount: p.amount,
		status: p.status,
	});

	for (const [intentId, payments] of paymentsByIntent) {
		if (payments.length > 1) {
			for (const p of payments)
				add({
					category: "payment",
					type: "duplicate",
					explanation: `${payments.length} payment records share the payment intent ${intentId}.`,
					stripe: intentsById.has(intentId)
						? {
								id: intentId,
								amount: dollars(intentsById.get(intentId)!.amount),
								status: intentsById.get(intentId)!.status,
							}
						: null,
					db: dbRef(p),
					bookingId: p.bookingId,
				});
		}
	}

	const succeededByBooking = new Map<string, StripePaymentIntent[]>();
	for (const pi of stripe.paymentIntents) {
		if (pi.status === "succeeded" && pi.bookingId) {
			const list = succeededByBooking.get(pi.bookingId) ?? [];
			list.push(pi);
			succeededByBooking.set(pi.bookingId, list);
		}
		const payment = paymentsByIntent.get(pi.id)?.[0];
		const stripeRef = { id: pi.id, amount: dollars(pi.amount), status: pi.status };
		if (!payment) {
			add({
				category: "payment",
				type: "missing_in_db",
				explanation: `Stripe has a payment intent (${pi.status}) with no payment record.`,
				stripe: stripeRef,
				db: null,
				bookingId: pi.bookingId ?? null,
			});
			continue;
		}
		if (toCents(payment.amount) !== pi.amount) {
			add({
				category: "payment",
				type: "amount_differs",
				explanation: "The payment intent's amount is not the recorded payment amount.",
				stripe: stripeRef,
				db: dbRef(payment),
				bookingId: payment.bookingId,
			});
		}
		if (paymentStatusFor(pi.status) !== payment.status) {
			add({
				category: "payment",
				type: "status_differs",
				explanation: `Stripe says ${pi.status}; the record says ${payment.status}.`,
				stripe: stripeRef,
				db: dbRef(payment),
				bookingId: payment.bookingId,
			});
		}
		if (pi.status === "succeeded" && pi.charge) {
			const refundedCents = refundedCentsOf(payment);
			if (pi.charge.amountRefunded !== refundedCents) {
				add({
					category: "charge",
					type: "amount_differs",
					explanation: `The charge shows ${money(pi.charge.amountRefunded)} refunded; the record's succeeded refunds total ${money(refundedCents)}.`,
					stripe: { id: pi.charge.id, amount: dollars(pi.charge.amountRefunded), status: pi.charge.status },
					db: { ...dbRef(payment), amount: dollars(refundedCents) },
					bookingId: payment.bookingId,
				});
			}
		}
	}
	for (const [bookingId, intents] of succeededByBooking) {
		if (intents.length < 2) continue;
		for (const pi of intents)
			add({
				category: "payment",
				type: "duplicate",
				explanation: `${intents.length} payment intents succeeded for the same booking: the customer may have been charged twice.`,
				stripe: { id: pi.id, amount: dollars(pi.amount), status: pi.status },
				db: paymentsByIntent.get(pi.id)?.[0] ? dbRef(paymentsByIntent.get(pi.id)![0]) : null,
				bookingId,
			});
	}
	for (const p of db.payments) {
		if (!p.paymentIntentId) continue;
		if (!intentsById.has(p.paymentIntentId) && p.status !== "pending" && !p.contextOnly) {
			add({
				category: "payment",
				type: "missing_in_stripe",
				explanation: `The record (${p.status}) names a payment intent Stripe did not return.`,
				stripe: null,
				db: dbRef(p),
				bookingId: p.bookingId,
			});
		}
	}

	// Refunds.
	const dbRefunds = new Map<string, { payment: DbPayment; amount: number | null; status: string }[]>();
	for (const p of db.payments) {
		for (const r of dbRefundsOf(p)) {
			const list = dbRefunds.get(r.refundId) ?? [];
			list.push({ payment: p, amount: r.amount, status: r.status });
			dbRefunds.set(r.refundId, list);
		}
	}
	const stripeRefundIds = new Set(stripe.refunds.map((r) => r.id));
	for (const [refundId, entries] of dbRefunds) {
		if (entries.length > 1) {
			for (const e of entries)
				add({
					category: "refund",
					type: "duplicate",
					explanation: `The refund ${refundId} is recorded on ${entries.length} payments.`,
					stripe: null,
					db: { ...dbRef(e.payment), amount: e.amount, status: e.status },
					bookingId: e.payment.bookingId,
				});
		}
		if (!stripeRefundIds.has(refundId) && !entries[0].payment.contextOnly) {
			const e = entries[0];
			add({
				category: "refund",
				type: "missing_in_stripe",
				explanation: `A ${e.status} refund is recorded that Stripe did not return.`,
				stripe: { id: refundId, amount: null, status: null },
				db: { ...dbRef(e.payment), amount: e.amount, status: e.status },
				bookingId: e.payment.bookingId,
			});
		}
	}
	for (const r of stripe.refunds) {
		const entry = dbRefunds.get(r.id)?.[0];
		const stripeRef = { id: r.id, amount: dollars(r.amount), status: r.status };
		if (!entry) {
			const payment = r.paymentIntentId ? paymentsByIntent.get(r.paymentIntentId)?.[0] : undefined;
			add({
				category: "refund",
				type: "missing_in_db",
				explanation: payment
					? "Stripe has a refund on this payment that is not recorded."
					: "Stripe has a refund for a payment intent with no payment record.",
				stripe: stripeRef,
				db: payment ? dbRef(payment) : null,
				bookingId: payment?.bookingId ?? null,
			});
			continue;
		}
		const dbRefAmount = { ...dbRef(entry.payment), amount: entry.amount, status: entry.status };
		if (entry.amount !== null && toCents(entry.amount) !== r.amount) {
			add({
				category: "refund",
				type: "amount_differs",
				explanation: "Stripe's refund amount is not the recorded amount.",
				stripe: stripeRef,
				db: dbRefAmount,
				bookingId: entry.payment.bookingId,
			});
		}
		if (refundStatusFor(r.status) !== entry.status && !(entry.status === "requested" && r.status === "pending")) {
			add({
				category: "refund",
				type: "status_differs",
				explanation: `Stripe says ${r.status}; the record says ${entry.status}.`,
				stripe: stripeRef,
				db: dbRefAmount,
				bookingId: entry.payment.bookingId,
			});
		}
	}

	// Transfers <-> released earnings, and the platform fee they imply.
	const transfersById = new Map(stripe.transfers.map((t) => [t.id, t]));
	const earningsByTransfer = new Map<string, DbEarning[]>();
	for (const e of db.earnings) {
		if (!e.transferId) continue;
		const list = earningsByTransfer.get(e.transferId) ?? [];
		list.push(e);
		earningsByTransfer.set(e.transferId, list);
	}
	const earningRef = (e: DbEarning) => ({
		type: "earning" as const,
		id: String(e._id),
		amount: e.amount,
		status: e.status,
	});
	const paymentForBooking = new Map<string, DbPayment>();
	for (const p of db.payments) if (p.status === "completed") paymentForBooking.set(String(p.bookingId), p);

	for (const [transferId, earnings] of earningsByTransfer) {
		if (earnings.length > 1)
			for (const e of earnings)
				add({
					category: "transfer",
					type: "duplicate",
					explanation: `${earnings.length} earnings share the transfer ${transferId}.`,
					stripe: null,
					db: earningRef(e),
					bookingId: e.bookingId,
				});
	}
	for (const e of db.earnings) {
		if (e.status === "completed" && !e.transferId) {
			add({
				category: "transfer",
				type: "missing_in_stripe",
				explanation: "The earning is marked released but has no transfer.",
				stripe: null,
				db: earningRef(e),
				bookingId: e.bookingId,
			});
			continue;
		}
		if (!e.transferId) continue;
		const t = transfersById.get(e.transferId);
		if (!t) {
			add({
				category: "transfer",
				type: "missing_in_stripe",
				explanation: "The earning names a transfer Stripe did not return.",
				stripe: { id: e.transferId, amount: null, status: null },
				db: earningRef(e),
				bookingId: e.bookingId,
			});
			continue;
		}
		const stripeRef = { id: t.id, amount: dollars(t.amount), status: transferStatus(t), account: t.destination };
		if (toCents(e.amount) !== t.amount) {
			add({
				category: "transfer",
				type: "amount_differs",
				explanation: "The transfer amount is not the earning amount.",
				stripe: stripeRef,
				db: earningRef(e),
				bookingId: e.bookingId,
			});
		}
		if (e.status !== "completed" || t.amountReversed > 0) {
			add({
				category: "transfer",
				type: "status_differs",
				explanation:
					t.amountReversed > 0
						? `${money(t.amountReversed)} of the transfer was reversed; the earning still counts it as released.`
						: `A transfer exists but the earning is ${e.status}.`,
				stripe: stripeRef,
				db: earningRef(e),
				bookingId: e.bookingId,
			});
		}
		const payment = paymentForBooking.get(String(e.bookingId));
		const intent = payment?.paymentIntentId ? intentsById.get(payment.paymentIntentId) : undefined;
		if (payment && intent && intent.status === "succeeded") {
			const actualFee = intent.amountReceived - t.amount;
			const expected = expectedFeeCents(payment.amount, e.feePercent ?? input.defaultFeePercent);
			if (actualFee !== expected) {
				add({
					category: "fee",
					type: "amount_differs",
					explanation: `The platform kept ${money(actualFee)} (charge ${money(intent.amountReceived)} - transfer ${money(t.amount)}); the system's fee at ${e.feePercent ?? input.defaultFeePercent}% is ${money(expected)}.`,
					stripe: { id: t.id, amount: dollars(actualFee), status: transferStatus(t) },
					db: { ...earningRef(e), amount: dollars(expected) },
					bookingId: e.bookingId,
				});
			}
		}
	}
	for (const t of stripe.transfers) {
		if (earningsByTransfer.has(t.id)) continue;
		add({
			category: "transfer",
			type: "missing_in_db",
			explanation: "Stripe has a transfer to a connected account that no earning records.",
			stripe: { id: t.id, amount: dollars(t.amount), status: transferStatus(t), account: t.destination },
			db: null,
		});
	}

	// Payouts (on connected accounts).
	const dbPayoutsById = new Map<string, DbPayout[]>();
	for (const p of db.payouts) {
		const list = dbPayoutsById.get(p.payoutId) ?? [];
		list.push(p);
		dbPayoutsById.set(p.payoutId, list);
	}
	const stripePayoutIds = new Set(stripe.payouts.map((p) => p.id));
	const payoutRef = (p: DbPayout) => ({
		type: "payout" as const,
		id: String(p._id),
		amount: p.amount,
		status: p.status,
	});
	for (const [payoutId, list] of dbPayoutsById) {
		if (list.length > 1)
			for (const p of list)
				add({
					category: "payout",
					type: "duplicate",
					explanation: `${list.length} payout records share ${payoutId}.`,
					stripe: null,
					db: payoutRef(p),
				});
		if (!stripePayoutIds.has(payoutId))
			add({
				category: "payout",
				type: "missing_in_stripe",
				explanation: "The payout record names a payout Stripe did not return for that account.",
				stripe: { id: payoutId, amount: null, status: null, account: list[0].destinationAccount ?? null },
				db: payoutRef(list[0]),
			});
	}
	for (const p of stripe.payouts) {
		const record = dbPayoutsById.get(p.id)?.[0];
		const stripeRef = { id: p.id, amount: dollars(p.amount), status: p.status, account: p.account };
		if (!record) {
			add({
				category: "payout",
				type: "missing_in_db",
				explanation: "Stripe has a payout on a provider's account with no payout record.",
				stripe: stripeRef,
				db: null,
			});
			continue;
		}
		if (toCents(record.amount) !== p.amount)
			add({
				category: "payout",
				type: "amount_differs",
				explanation: "The payout amount is not the recorded amount.",
				stripe: stripeRef,
				db: payoutRef(record),
			});
		if (payoutStatusFor(p.status) !== record.status)
			add({
				category: "payout",
				type: "status_differs",
				explanation: `Stripe says ${p.status}; the record says ${record.status}.`,
				stripe: stripeRef,
				db: payoutRef(record),
			});
	}

	return { mismatches: out, counts: countMismatches(out), checked: checkedCounts(input) };
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const transferStatus = (t: StripeTransfer) =>
	t.amountReversed >= t.amount && t.amount > 0 ? "reversed" : t.amountReversed > 0 ? "partially_reversed" : "paid";

/** The refunds a payment records: admin entries, plus the cancellation/expiry refund in the top-level fields. */
export const dbRefundsOf = (p: DbPayment) => {
	const out: { refundId: string; amount: number | null; status: string }[] = [];
	for (const r of p.refunds ?? [])
		if (r.refundId) out.push({ refundId: r.refundId, amount: r.amount, status: r.status });
	if (p.refundId && !out.some((r) => r.refundId === p.refundId)) {
		// With no admin entries the top-level amount is this refund's; never compared otherwise (it is a total then).
		out.push({
			refundId: p.refundId,
			amount: (p.refunds ?? []).length ? null : (p.refundAmount ?? null),
			status: p.refundStatus ?? "pending",
		});
	}
	return out;
};

/** Succeeded refunds recorded on a payment, in cents (what the charge's amount_refunded should equal). */
export const refundedCentsOf = (p: DbPayment) => {
	let cents = 0;
	const entries = p.refunds ?? [];
	for (const r of entries) if (r.status === "succeeded") cents += toCents(r.amount);
	if (p.refundId && p.refundStatus === "succeeded" && !entries.some((r) => r.refundId === p.refundId))
		cents += toCents(p.refundAmount ?? 0);
	return cents;
};

export const countMismatches = (mismatches: Mismatch[]) => {
	const byType = Object.fromEntries(MISMATCH_TYPES.map((t) => [t, 0])) as Record<MismatchType, number>;
	const byCategory = Object.fromEntries(MISMATCH_CATEGORIES.map((c) => [c, 0])) as Record<MismatchCategory, number>;
	for (const m of mismatches) {
		byType[m.type]++;
		byCategory[m.category]++;
	}
	return { total: mismatches.length, byType, byCategory };
};

const checkedCounts = (input: ReconciliationInput) => ({
	stripe: {
		paymentIntents: input.stripe.paymentIntents.length,
		refunds: input.stripe.refunds.length,
		transfers: input.stripe.transfers.length,
		payouts: input.stripe.payouts.length,
	},
	db: { payments: input.db.payments.length, earnings: input.db.earnings.length, payouts: input.db.payouts.length },
});

/** Stripe totals for a run, in dollars (succeeded payments, succeeded refunds, transfers net of reversals, paid payouts). */
export const stripeTotals = (stripe: ReconciliationInput["stripe"]) => {
	const sum = (values: number[]) => dollars(values.reduce((a, b) => a + b, 0));
	return {
		paid: sum(stripe.paymentIntents.filter((p) => p.status === "succeeded").map((p) => p.amountReceived)),
		refunded: sum(stripe.refunds.filter((r) => r.status === "succeeded").map((r) => r.amount)),
		transferred: sum(stripe.transfers.map((t) => t.amount - t.amountReversed)),
		paidOut: sum(stripe.payouts.filter((p) => p.status === "paid").map((p) => p.amount)),
	};
};

// ---------------------------------------------------------------------------------------------------------------
// Money summary (database side, pure)

export interface SummaryInput {
	payments: {
		amount: number;
		status: string;
		paidAt?: Date | null;
		createdAt: Date;
		bookingId: string;
		refundId?: string | null;
		refundStatus?: string | null;
		refundAmount?: number | null;
		refundCreated?: Date | null;
		refunds?:
			| {
					refundId?: string | null;
					amount: number;
					status: string;
					createdAt?: Date | null;
					requestedAt?: Date | null;
			  }[]
			| null;
	}[];
	/** Earnings created in the range (fees) and released in the range (released). */
	earningsCreated: { amount: number; bookingId: string; feePercent?: number | null }[];
	earningsReleased: { amount: number }[];
	/** Paid amounts of the bookings whose earnings were created in the range. */
	paidByBooking: Map<string, number>;
	payouts: { amount: number; status: string; paidAt?: Date | null; failedAt?: Date | null; createdAt: Date }[];
	range: { from: Date; to: Date };
	defaultFeePercent: number;
}

const inRange = (d: Date | null | undefined, r: { from: Date; to: Date }) =>
	!!d && new Date(d).getTime() >= r.from.getTime() && new Date(d).getTime() < r.to.getTime();

/** Gross paid, refunds, platform fees, provider earnings released, payouts paid and failed: all in dollars. */
export const summariseMoney = (input: SummaryInput) => {
	const r = input.range;
	let paid = 0;
	let paidCount = 0;
	let refunded = 0;
	let refundCount = 0;
	for (const p of input.payments) {
		if (p.status === "completed" && inRange(p.paidAt ?? p.createdAt, r)) {
			paid += toCents(p.amount);
			paidCount++;
		}
		const entries = p.refunds ?? [];
		for (const e of entries)
			if (e.status === "succeeded" && inRange(e.createdAt ?? e.requestedAt, r)) {
				refunded += toCents(e.amount);
				refundCount++;
			}
		if (
			p.refundId &&
			p.refundStatus === "succeeded" &&
			!entries.some((e) => e.refundId === p.refundId) &&
			inRange(p.refundCreated, r)
		) {
			refunded += toCents(p.refundAmount ?? 0);
			refundCount++;
		}
	}
	let fees = 0;
	for (const e of input.earningsCreated) {
		const paidForBooking = input.paidByBooking.get(String(e.bookingId));
		fees +=
			paidForBooking !== undefined
				? toCents(paidForBooking) - toCents(e.amount)
				: Math.round(
						(toCents(e.amount) * (e.feePercent ?? input.defaultFeePercent)) /
							(100 - (e.feePercent ?? input.defaultFeePercent)),
					);
	}
	const released = input.earningsReleased.reduce((a, e) => a + toCents(e.amount), 0);
	let payoutsPaid = 0;
	let payoutsPaidCount = 0;
	let payoutsFailed = 0;
	let payoutsFailedCount = 0;
	for (const p of input.payouts) {
		if (p.status === "paid" && inRange(p.paidAt ?? p.createdAt, r)) {
			payoutsPaid += toCents(p.amount);
			payoutsPaidCount++;
		}
		if ((p.status === "failed" || p.status === "cancelled") && inRange(p.failedAt ?? p.createdAt, r)) {
			payoutsFailed += toCents(p.amount);
			payoutsFailedCount++;
		}
	}
	return {
		grossPaid: { amount: dollars(paid), count: paidCount },
		refunds: { amount: dollars(refunded), count: refundCount },
		netPaid: dollars(paid - refunded),
		platformFees: { amount: dollars(fees), count: input.earningsCreated.length },
		earningsReleased: { amount: dollars(released), count: input.earningsReleased.length },
		payoutsPaid: { amount: dollars(payoutsPaid), count: payoutsPaidCount },
		payoutsFailed: { amount: dollars(payoutsFailed), count: payoutsFailedCount },
	};
};

/**
 * What the platform owes against what Stripe holds. Earnings awaiting release are still in the platform's Stripe
 * balance and must be transferred; provider balances are already in their connected accounts (owed by Stripe to
 * them, not by the platform). `coverage` = platform available balance - earnings awaiting release.
 */
export const owedVersusHeld = (input: {
	pendingEarnings: number;
	providerBalances: number;
	platformBalance: { available: number; pending: number } | null;
}) => ({
	earningsAwaitingRelease: dollars(toCents(input.pendingEarnings)),
	providerBalances: dollars(toCents(input.providerBalances)),
	platformBalance: input.platformBalance,
	coverage: input.platformBalance
		? dollars(toCents(input.platformBalance.available) - toCents(input.pendingEarnings))
		: null,
	explanation:
		"Earnings awaiting release are owed by the platform and still sit in its Stripe balance until transferred. Provider balances were already transferred to the providers' Stripe accounts and are waiting for them to request a payout. Coverage is the platform's available Stripe balance minus the earnings awaiting release; below zero, releases will fail with 'Insufficient platform balance'.",
});

/** A range for a run or a summary: both dates, from before to, at most `maxDays`. */
export const parseRange = (fromText: unknown, toText: unknown, maxDays: number, now = new Date()) => {
	const parse = (value: unknown, endOfDay: boolean) => {
		if (typeof value !== "string" || !value) return null;
		const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
		const d = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
		if (Number.isNaN(d.getTime())) return undefined;
		return dateOnly && endOfDay ? new Date(d.getTime() + 24 * 3600 * 1000) : d;
	};
	const from = parse(fromText, false);
	const to = parse(toText, true) ?? (toText ? undefined : now);
	if (!from) return { ok: false as const, field: "from", message: "from is required (YYYY-MM-DD or an ISO time)." };
	if (!to) return { ok: false as const, field: "to", message: "to must be a date (YYYY-MM-DD) or an ISO time." };
	const end = to > now ? now : to;
	if (from >= end) return { ok: false as const, field: "from", message: "from must be before to (and in the past)." };
	if (end.getTime() - from.getTime() > maxDays * 24 * 3600 * 1000)
		return { ok: false as const, field: "to", message: `The range can be at most ${maxDays} days.` };
	return { ok: true as const, from, to: end };
};
