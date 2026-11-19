// Search for the operations console: the global search (command palette) and the `q` of the users, bookings and
// payments lists. Pure: the plan says what the text looks like, the builders turn it into MongoDB filters.
//
// Every filter is an exact match or an index range:
// - ids, receipt references (HH-1A2B3C4D) and Stripe ids are exact matches on indexed fields;
// - names and emails are case-insensitive PREFIX matches written as a range [prefix, prefix + U+FFFF) and run with
//   SEARCH_COLLATION, which the *_ci indexes share, so each is one bounded index scan (U+FFFF sorts after every
//   character in ICU collation, so the range is exactly "starts with");
// - phone numbers are an anchored, case-sensitive prefix of the stored text (a tight index range on { phone: 1 }).
// No unanchored or case-insensitive regular expression is ever built, and the text is never used as a pattern.
import mongoose from "mongoose";
import { escapeRegex } from "./listQuery";

export const SEARCH_COLLATION = { locale: "en", strength: 2 } as const;
export const MAX_QUERY_LENGTH = 100;
/** Names and emails need this many characters before they are searched as a prefix. */
export const MIN_PREFIX_LENGTH = 2;

export class SearchQueryError extends Error {
	readonly field = "q";
}

export type StripeKind = "payment_intent" | "refund" | "payout" | "transfer" | "account" | "charge" | "event";

const STRIPE_PREFIXES: Record<string, StripeKind> = {
	pi: "payment_intent",
	re: "refund",
	po: "payout",
	tr: "transfer",
	acct: "account",
	ch: "charge",
	evt: "event",
};

export interface SearchPlan {
	text: string;
	objectId?: string;
	/** Booking receipt reference, normalised to "HH-XXXXXXXX". */
	reference?: string;
	stripeId?: { kind: StripeKind; id: string };
	/** Lower-cased email prefix. */
	email?: string;
	/** One word: first or last name. Two: first and last name (more words: the first and the last). */
	names?: string[];
	/** Phone prefix as typed. */
	phone?: string;
}

// Control characters, and U+FFFF which the prefix range uses as its upper bound.
const FORBIDDEN = /[\u0000-\u001f\u007f￿]/;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const REFERENCE = /^(?:hh-?)?([a-f\d]{8})$/i;
const STRIPE_ID = /^(pi|re|po|tr|acct|ch|evt)_[A-Za-z0-9]{6,64}$/;
const PHONE = /^\+?[\d\s().-]{6,30}$/;
const NAME_WORD = /^[\p{L}\p{M}'.-]+$/u;

/** Classifies search text. Throws SearchQueryError for anything that is not a single, sane string. */
export const buildSearchPlan = (raw: unknown): SearchPlan => {
	if (typeof raw !== "string") throw new SearchQueryError("q must be given once, as text.");
	const text = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
	if (!text) throw new SearchQueryError("Enter something to search for.");
	if (text.length > MAX_QUERY_LENGTH) {
		throw new SearchQueryError(`q must be at most ${MAX_QUERY_LENGTH} characters.`);
	}
	if (FORBIDDEN.test(text)) throw new SearchQueryError("q contains characters that cannot be searched.");

	const plan: SearchPlan = { text };
	if (OBJECT_ID.test(text)) {
		plan.objectId = text.toLowerCase();
		return plan;
	}
	const reference = REFERENCE.exec(text);
	if (reference) plan.reference = `HH-${reference[1].toUpperCase()}`;
	const stripe = STRIPE_ID.exec(text);
	if (stripe) {
		plan.stripeId = { kind: STRIPE_PREFIXES[stripe[1]], id: text };
		return plan;
	}
	if (text.includes("@")) {
		if (!text.includes(" ") && text.length >= MIN_PREFIX_LENGTH) plan.email = text.toLowerCase();
		return plan;
	}
	if (PHONE.test(text) && text.replace(/\D/g, "").length >= 6) {
		plan.phone = text;
		return plan;
	}
	const words = text.split(" ").filter((word) => NAME_WORD.test(word));
	if (words.length && words.length === text.split(" ").length) {
		const chosen = words.length > 2 ? [words[0], words[words.length - 1]] : words;
		if (chosen.every((word) => word.length >= (chosen.length === 1 ? MIN_PREFIX_LENGTH : 1))) plan.names = chosen;
	}
	return plan;
};

/** True when the plan can match something (an empty plan means the text is not searchable as anything). */
export const isSearchable = (plan: SearchPlan) =>
	!!(plan.objectId || plan.reference || plan.stripeId || plan.email || plan.names || plan.phone);

/** Case-insensitive "starts with" as an index range; run with SEARCH_COLLATION. */
export const prefixRange = (prefix: string) => ({ $gte: prefix, $lt: `${prefix}￿` });

export interface SearchQuery {
	filter: Record<string, unknown>;
	/** Run with SEARCH_COLLATION (the *_ci indexes). */
	collation: boolean;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

const nameQueries = (names: string[]): SearchQuery[] =>
	names.length === 1
		? [
				{ filter: { firstName: prefixRange(names[0]) }, collation: true },
				{ filter: { lastName: prefixRange(names[0]) }, collation: true },
			]
		: [{ filter: { firstName: prefixRange(names[0]), lastName: prefixRange(names[1]) }, collation: true }];

/** Queries over users (customers and providers), each run separately and merged. */
export const userSearchQueries = (plan: SearchPlan): SearchQuery[] => {
	const queries: SearchQuery[] = [];
	if (plan.objectId) queries.push({ filter: { _id: oid(plan.objectId) }, collation: false });
	if (plan.email) queries.push({ filter: { email: prefixRange(plan.email) }, collation: true });
	if (plan.phone) queries.push({ filter: { phone: { $regex: `^${escapeRegex(plan.phone)}` } }, collation: false });
	if (plan.names) queries.push(...nameQueries(plan.names));
	return queries;
};

/** Queries over provider applications. */
export const applicationSearchQueries = (plan: SearchPlan): SearchQuery[] => {
	const queries: SearchQuery[] = [];
	if (plan.objectId) queries.push({ filter: { _id: oid(plan.objectId) }, collation: false });
	if (plan.email) queries.push({ filter: { email: prefixRange(plan.email) }, collation: true });
	if (plan.names) queries.push(...nameQueries(plan.names));
	return queries;
};

/**
 * Queries over bookings by their own fields. Bookings of matching people are found separately (by user id).
 * `addressPrefix` searches the start of the address (house number and street), for the bookings list only.
 */
export const bookingSearchQueries = (plan: SearchPlan, { addressPrefix = false } = {}): SearchQuery[] => {
	const queries: SearchQuery[] = [];
	if (plan.objectId) queries.push({ filter: { _id: oid(plan.objectId) }, collation: false });
	if (plan.reference) queries.push({ filter: { reference: plan.reference }, collation: false });
	if (addressPrefix && !plan.objectId && !plan.stripeId && !plan.email && plan.text.length >= 3) {
		queries.push({ filter: { address: prefixRange(plan.text) }, collation: true });
	}
	return queries;
};

/** Queries over payments by their own fields (id, booking id, Stripe payment intent or refund id). */
export const paymentSearchQueries = (plan: SearchPlan): SearchQuery[] => {
	const queries: SearchQuery[] = [];
	if (plan.objectId) {
		queries.push({ filter: { _id: oid(plan.objectId) }, collation: false });
		queries.push({ filter: { bookingId: oid(plan.objectId) }, collation: false });
	}
	if (plan.stripeId?.kind === "payment_intent") {
		queries.push({ filter: { paymentIntentId: plan.stripeId.id }, collation: false });
	}
	if (plan.stripeId?.kind === "refund") {
		queries.push({ filter: { refundId: plan.stripeId.id }, collation: false });
		queries.push({ filter: { "refunds.refundId": plan.stripeId.id }, collation: false });
	}
	return queries;
};
