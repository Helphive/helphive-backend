// Read-only Stripe listing for reconciliation and disputes: paginated with a cap, a per-request timeout and an overall
// deadline. Every object is reduced at once to the few fields compared (ids, amounts, statuses, times), so card and
// bank details are never kept, stored or logged. Nothing here creates, updates or deletes anything in Stripe.
import type Stripe from "stripe";
import type { StripePaymentIntent, StripePayout, StripeRefund, StripeTransfer } from "./reconciliation";

export const STRIPE_REQUEST_TIMEOUT_MS = 15_000;
export const STRIPE_PAGE_SIZE = 100;
/** Most objects read per kind in one run; past it the run is marked partial. */
export const STRIPE_MAX_OBJECTS = 5000;
export const STRIPE_MAX_ACCOUNTS = 100;

export class StripeDeadlineError extends Error {}

export interface ReadBudget {
	deadline: number;
	now?: () => number;
	notes: string[];
}

type Page<T> = { data: T[]; has_more: boolean };

/** Lists every page of a Stripe list call (newest first) until the end, the cap or the deadline. */
export const listAll = async <T extends { id: string }>(
	what: string,
	fetchPage: (startingAfter: string | undefined) => Promise<Page<T>>,
	budget: ReadBudget,
	max = STRIPE_MAX_OBJECTS,
): Promise<T[]> => {
	const now = budget.now ?? Date.now;
	const out: T[] = [];
	let startingAfter: string | undefined;
	for (;;) {
		if (now() > budget.deadline)
			throw new StripeDeadlineError(`Stripe did not answer in time while listing ${what}.`);
		const page = await fetchPage(startingAfter);
		out.push(...page.data);
		if (!page.has_more || page.data.length === 0) break;
		if (out.length >= max) {
			budget.notes.push(`Only the first ${max} ${what} were read; the range has more. Use a shorter range.`);
			break;
		}
		startingAfter = page.data[page.data.length - 1].id;
	}
	return out;
};

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
const idOf = (value: unknown): string | null =>
	typeof value === "string"
		? value
		: value && typeof value === "object" && "id" in value
			? String((value as any).id)
			: null;

export const toIntent = (pi: Stripe.PaymentIntent): StripePaymentIntent => {
	const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
	return {
		id: pi.id,
		amount: pi.amount,
		amountReceived: pi.amount_received ?? 0,
		status: pi.status,
		created: pi.created,
		bookingId: typeof pi.metadata?.bookingId === "string" ? pi.metadata.bookingId : null,
		charge: charge
			? {
					id: charge.id,
					amount: charge.amount,
					amountRefunded: charge.amount_refunded,
					status: charge.status,
					disputed: !!charge.disputed,
				}
			: null,
	};
};

export const toRefund = (r: Stripe.Refund): StripeRefund => ({
	id: r.id,
	amount: r.amount,
	status: r.status ?? "pending",
	paymentIntentId: idOf(r.payment_intent),
	created: r.created,
});

export const toTransfer = (t: Stripe.Transfer): StripeTransfer => ({
	id: t.id,
	amount: t.amount,
	amountReversed: t.amount_reversed ?? 0,
	destination: idOf(t.destination),
	created: t.created,
});

export const toPayout = (p: Stripe.Payout, account: string): StripePayout => ({
	id: p.id,
	amount: p.amount,
	status: p.status,
	account,
	created: p.created,
});

const options = (extra: Stripe.RequestOptions = {}): Stripe.RequestOptions => ({
	timeout: STRIPE_REQUEST_TIMEOUT_MS,
	maxNetworkRetries: 1,
	...extra,
});

/** Everything Stripe has for the range: platform payment intents (with their charge), refunds, transfers, and payouts on the given connected accounts. */
export const readStripeRange = async (
	stripe: Stripe,
	range: { from: Date; to: Date },
	accounts: string[],
	budget: ReadBudget,
) => {
	const created = { gte: seconds(range.from), lt: seconds(range.to) };
	const [intents, refunds, transfers] = await Promise.all([
		listAll(
			"payment intents",
			(startingAfter) =>
				stripe.paymentIntents.list(
					{ created, limit: STRIPE_PAGE_SIZE, starting_after: startingAfter, expand: ["data.latest_charge"] },
					options(),
				),
			budget,
		),
		listAll(
			"refunds",
			(startingAfter) =>
				stripe.refunds.list({ created, limit: STRIPE_PAGE_SIZE, starting_after: startingAfter }, options()),
			budget,
		),
		listAll(
			"transfers",
			(startingAfter) =>
				stripe.transfers.list({ created, limit: STRIPE_PAGE_SIZE, starting_after: startingAfter }, options()),
			budget,
		),
	]);
	const payouts: StripePayout[] = [];
	const chosen = accounts.slice(0, STRIPE_MAX_ACCOUNTS);
	if (accounts.length > chosen.length)
		budget.notes.push(`Payouts were read for ${chosen.length} of ${accounts.length} connected accounts.`);
	for (const account of chosen) {
		const list = await listAll(
			`payouts of ${account}`,
			(startingAfter) =>
				stripe.payouts.list(
					{ created, limit: STRIPE_PAGE_SIZE, starting_after: startingAfter },
					options({ stripeAccount: account }),
				),
			budget,
			1000,
		);
		payouts.push(...list.map((p) => toPayout(p, account)));
	}
	return {
		paymentIntents: intents.map(toIntent),
		refunds: refunds.map(toRefund),
		transfers: transfers.map(toTransfer),
		payouts,
	};
};

/**
 * Objects the database names that the range listing did not return (made just outside the range), fetched one by one
 * so they are not reported missing. At most `max` in all; a 404 from Stripe means it really is missing.
 */
export const retrieveMissing = async (
	stripe: Stripe,
	ids: { intents: string[]; refunds: string[]; transfers: string[]; payouts: { id: string; account: string }[] },
	budget: ReadBudget,
	max = 200,
) => {
	const now = budget.now ?? Date.now;
	let left = max;
	const take = <T>(list: T[]) => {
		const chosen = list.slice(0, Math.max(0, left));
		left -= chosen.length;
		return chosen;
	};
	const notFound = (error: any) => error?.statusCode === 404 || error?.code === "resource_missing";
	const one = async <T>(fetch: () => Promise<T>): Promise<T | null> => {
		if (now() > budget.deadline) return null;
		try {
			return await fetch();
		} catch (error) {
			if (notFound(error)) return null;
			throw error;
		}
	};
	const intents = (
		await Promise.all(
			take(ids.intents).map((id) =>
				one(() => stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] }, options())),
			),
		)
	).filter(Boolean) as Stripe.PaymentIntent[];
	const refunds = (
		await Promise.all(take(ids.refunds).map((id) => one(() => stripe.refunds.retrieve(id, {}, options()))))
	).filter(Boolean) as Stripe.Refund[];
	const transfers = (
		await Promise.all(take(ids.transfers).map((id) => one(() => stripe.transfers.retrieve(id, {}, options()))))
	).filter(Boolean) as Stripe.Transfer[];
	const payouts: StripePayout[] = [];
	for (const p of take(ids.payouts)) {
		const found = await one(() => stripe.payouts.retrieve(p.id, {}, options({ stripeAccount: p.account })));
		if (found) payouts.push(toPayout(found, p.account));
	}
	const skipped =
		ids.intents.length + ids.refunds.length + ids.transfers.length + ids.payouts.length - (max - Math.max(0, left));
	if (skipped > 0) budget.notes.push(`${skipped} records outside the range were not looked up individually.`);
	return {
		paymentIntents: intents.map(toIntent),
		refunds: refunds.map(toRefund),
		transfers: transfers.map(toTransfer),
		payouts,
	};
};

/** The platform's Stripe balance in dollars (USD), or null if Stripe does not answer within the timeout. */
export const readPlatformBalance = async (stripe: Stripe) => {
	const balance = await stripe.balance.retrieve({}, options({ maxNetworkRetries: 0 }));
	const usd = (list: { amount: number; currency: string }[]) =>
		list.filter((b) => b.currency === "usd").reduce((a, b) => a + b.amount, 0) / 100;
	return { available: usd(balance.available), pending: usd(balance.pending), currency: "usd" };
};
