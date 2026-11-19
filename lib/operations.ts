// Pure rules behind the operations console (no database, no Express): period bounds and comparisons, the attention
// list, coarse locations for the live map, refund amounts, booking display-status filters and receipt references.
// The controllers in controllers/admin/ fetch the records and call these; tests/operations.test.ts covers them.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------------------------
// Money

/** What the provider earns of a booking's payment (controllers/user-controllers: completing a booking). */
export const PROVIDER_SHARE = 0.95;

export const toCents = (dollars: number) => Math.round(Number(dollars) * 100);
export const fromCents = (cents: number) => Math.round(cents) / 100;
export const roundMoney = (dollars: number) => fromCents(toCents(dollars));

/** The platform's fee on a payment: what is left after the provider's share. */
export const platformFeeOf = (paidAmount: number) =>
	fromCents(toCents(paidAmount) - toCents(paidAmount * PROVIDER_SHARE));

/** The platform's fee implied by an earning (earning = paid x PROVIDER_SHARE). */
export const platformFeeFromEarning = (earningAmount: number) =>
	fromCents(Math.round((toCents(earningAmount) * (1 - PROVIDER_SHARE)) / PROVIDER_SHARE));

// ---------------------------------------------------------------------------------------------------------------
// Booking references and display status

/** The receipt number the apps show: "HH-" and the last 8 hex digits of the id, upper case. */
export const bookingReference = (id: unknown) => `HH-${String(id).slice(-8).toUpperCase()}`;

export const DISPLAY_STATUSES = [
	"scheduled",
	"accepted",
	"awaiting_start_approval",
	"in_progress",
	"completed",
	"cancelled",
	"expired",
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

/** Same text the booking-expired task stores (controllers/user-controllers/utils/booking.utils.ts). */
export const EXPIRED_REASON = "Expired: no provider accepted before the start time.";

// A cancellation with no reason, no provider and cancelled at or after the start time is a legacy expiry.
const LEGACY_EXPIRY = {
	cancellationReason: { $in: [null, ""] },
	providerId: null,
	$expr: { $gte: ["$cancelledAt", "$startDate"] },
};

/**
 * MongoDB filter matching the bookings whose displayStatus (getBookingDisplayStatus in booking.utils.ts) is `value`,
 * or null when it is not a display status. `now` decides whether an unassigned pending booking has expired.
 */
export const displayStatusFilter = (value: string, now: Date): Record<string, unknown> | null => {
	switch (value) {
		case "scheduled":
			return {
				status: "pending",
				userApprovalRequested: { $ne: true },
				providerId: null,
				startDate: { $gte: now },
			};
		case "accepted":
			return { status: "pending", userApprovalRequested: { $ne: true }, providerId: { $ne: null } };
		case "awaiting_start_approval":
			return { status: "pending", userApprovalRequested: true };
		case "in_progress":
			return { status: "in progress" };
		case "completed":
			return { status: "completed" };
		case "cancelled":
			return { status: "cancelled", cancellationReason: { $ne: EXPIRED_REASON }, $nor: [LEGACY_EXPIRY] };
		case "expired":
			return {
				$or: [
					{ status: "cancelled", cancellationReason: EXPIRED_REASON },
					{ status: "cancelled", ...LEGACY_EXPIRY },
					{
						status: "pending",
						userApprovalRequested: { $ne: true },
						providerId: null,
						startDate: { $lt: now },
					},
				],
			};
		default:
			return null;
	}
};

/** Booking amount filter (rate x hours is not stored). */
export const amountBoundFilter = (op: "$gte" | "$lte", value: number) => ({
	$expr: { [op]: [{ $multiply: ["$rate", "$hours"] }, value] },
});

// ---------------------------------------------------------------------------------------------------------------
// Periods: today versus yesterday and this week versus last, in a time zone

export class TimeZoneError extends Error {}

const TZ_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/** "UTC" when absent; an IANA zone name the runtime knows; otherwise TimeZoneError. */
export const parseTimeZone = (value: unknown): string => {
	if (value === undefined || value === "") return "UTC";
	if (typeof value !== "string" || !TZ_NAME.test(value)) throw new TimeZoneError("tz must be an IANA time zone.");
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
	} catch {
		throw new TimeZoneError("tz must be an IANA time zone.");
	}
	return value;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const formatter = (tz: string) => {
	let f = formatterCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			weekday: "short",
		});
		formatterCache.set(tz, f);
	}
	return f;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Wall-clock parts of an instant in a zone. */
export const wallClock = (instant: number, tz: string) => {
	const parts = Object.fromEntries(
		formatter(tz)
			.formatToParts(new Date(instant))
			.map((p) => [p.type, p.value]),
	);
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour) % 24,
		minute: Number(parts.minute),
		second: Number(parts.second),
		weekdayIndex: WEEKDAYS.indexOf(parts.weekday), // 0 = Monday
	};
};

const offsetAt = (instant: number, tz: string) => {
	const w = wallClock(instant, tz);
	return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - (instant - (instant % 1000));
};

/** The instant of midnight starting the given calendar day in `tz` (day may overflow; Date.UTC normalises it). */
export const zonedMidnight = (year: number, month: number, day: number, tz: string) => {
	const local = Date.UTC(year, month - 1, day);
	let guess = local;
	for (let i = 0; i < 3; i++) guess = local - offsetAt(guess, tz);
	return guess;
};

export interface Period {
	from: Date;
	to: Date;
}

export interface PeriodSet {
	timeZone: string;
	today: Period;
	/** Yesterday from midnight to the same time of day as now, so the two compare like for like. */
	yesterday: Period;
	/** Monday to now. */
	thisWeek: Period;
	/** Last Monday to the same point in last week. */
	lastWeek: Period;
	/** Midnight today and the end of yesterday, for "completed today" style counts. */
	startOfToday: Date;
}

export const periodBounds = (now: Date, tz = "UTC"): PeriodSet => {
	const t = now.getTime();
	const w = wallClock(t, tz);
	const startToday = zonedMidnight(w.year, w.month, w.day, tz);
	const startYesterday = zonedMidnight(w.year, w.month, w.day - 1, tz);
	const startWeek = zonedMidnight(w.year, w.month, w.day - w.weekdayIndex, tz);
	const startLastWeek = zonedMidnight(w.year, w.month, w.day - w.weekdayIndex - 7, tz);
	return {
		timeZone: tz,
		today: { from: new Date(startToday), to: new Date(t) },
		yesterday: { from: new Date(startYesterday), to: new Date(startYesterday + (t - startToday)) },
		thisWeek: { from: new Date(startWeek), to: new Date(t) },
		lastWeek: { from: new Date(startLastWeek), to: new Date(startLastWeek + (t - startWeek)) },
		startOfToday: new Date(startToday),
	};
};

export interface Comparison {
	current: number;
	previous: number;
	change: number;
	/** Percentage change, one decimal; null when the previous value is 0. */
	changePct: number | null;
}

export const compareValues = (current: number, previous: number, money = false): Comparison => {
	const c = money ? roundMoney(current) : current;
	const p = money ? roundMoney(previous) : previous;
	const change = money ? roundMoney(c - p) : c - p;
	return { current: c, previous: p, change, changePct: p === 0 ? null : Math.round((change / p) * 1000) / 10 };
};

// ---------------------------------------------------------------------------------------------------------------
// Attention list

export const ATTENTION_THRESHOLDS = {
	/** A paid booking with no provider this close to its start (or past it). */
	unassignedWithinMs: 3 * HOUR,
	/** In progress this long past its scheduled end (start + booked hours). */
	overdueGraceMs: 1 * HOUR,
	/** A start request the customer has not approved for this long. */
	startRequestWaitMs: 15 * MINUTE,
	/** An earning still pending this long after it was created (the release task runs 30 s after completion). */
	earningReleaseGraceMs: 1 * HOUR,
	/** Provider applications waiting longer than this. */
	applicationWaitMs: 2 * DAY,
	/** Failed payouts and refunds from this far back are still listed. */
	failedLookbackMs: 30 * DAY,
	/** At most this many items of each kind (the count says how many there are). */
	perKind: 20,
} as const;

export type AttentionKind =
	| "unassigned_near_start"
	| "overdue_in_progress"
	| "start_request_waiting"
	| "earning_not_released"
	| "payout_failed"
	| "refund_failed"
	| "application_waiting";

export type Severity = "high" | "medium" | "low";

export interface AttentionItem {
	kind: AttentionKind;
	severity: Severity;
	/** Why it needs attention, in words for the operator (named "explanation" so the demo masking keeps it). */
	explanation: string;
	/** The time the item is measured from (start time, scheduled end, request, creation, failure). */
	at: Date;
	link: { type: "booking" | "earning" | "payout" | "payment" | "application"; id: string };
}

export interface AttentionCandidates {
	unassignedPaid: { _id: unknown; startDate: Date }[];
	inProgress: { _id: unknown; startDate: Date; hours: number }[];
	startRequests: { _id: unknown; startDate: Date; startRequestedAt?: Date | null }[];
	pendingEarnings: { _id: unknown; createdAt: Date; amount: number }[];
	failedPayouts: { _id: unknown; amount: number; failedAt?: Date | null; updatedAt?: Date | null; status: string }[];
	failedRefunds: {
		_id: unknown;
		refundAmount?: number | null;
		refundStatus?: string | null;
		refundCreated?: Date | null;
		updatedAt?: Date | null;
	}[];
	pendingApplications: { _id: unknown; createdAt: Date }[];
}

/** "45 min", "3 h 20 min", "2 days 4 h". */
export const formatDuration = (ms: number) => {
	const minutes = Math.max(0, Math.round(Math.abs(ms) / MINUTE));
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		const rest = minutes % 60;
		return rest ? `${hours} h ${rest} min` : `${hours} h`;
	}
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	return rest ? `${days} days ${rest} h` : `${days} days`;
};

const money = (amount: number | null | undefined) => `$${Number(amount ?? 0).toFixed(2)}`;
const time = (value: Date | string | null | undefined) => (value ? new Date(value).getTime() : NaN);

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * The attention list from candidate records the controller fetched with broad queries. Each rule decides on its own
 * thresholds, so a candidate that does not qualify (yet) is simply left out. Sorted by severity, then oldest first.
 */
export const buildAttention = (
	c: AttentionCandidates,
	now: Date,
	t: typeof ATTENTION_THRESHOLDS = ATTENTION_THRESHOLDS,
): { items: AttentionItem[]; counts: Record<AttentionKind, number> } => {
	const n = now.getTime();
	const items: AttentionItem[] = [];
	const id = (value: unknown) => String(value);

	for (const b of c.unassignedPaid) {
		const untilStart = time(b.startDate) - n;
		if (!(untilStart <= t.unassignedWithinMs)) continue;
		items.push({
			kind: "unassigned_near_start",
			severity: untilStart < HOUR ? "high" : "medium",
			explanation:
				untilStart >= 0
					? `Paid, no provider yet, starts in ${formatDuration(untilStart)}.`
					: `Paid, no provider, start time passed ${formatDuration(untilStart)} ago (it expires and is refunded).`,
			at: new Date(b.startDate),
			link: { type: "booking", id: id(b._id) },
		});
	}

	for (const b of c.inProgress) {
		const end = time(b.startDate) + Number(b.hours || 0) * HOUR;
		const late = n - end;
		if (!(late > t.overdueGraceMs)) continue;
		items.push({
			kind: "overdue_in_progress",
			severity: late > 6 * HOUR ? "high" : "medium",
			explanation: `In progress ${formatDuration(late)} past its scheduled end; nobody has completed it.`,
			at: new Date(end),
			link: { type: "booking", id: id(b._id) },
		});
	}

	for (const b of c.startRequests) {
		const since = time(b.startRequestedAt ?? b.startDate);
		const waited = n - since;
		if (!(waited > t.startRequestWaitMs)) continue;
		items.push({
			kind: "start_request_waiting",
			severity: waited > HOUR ? "high" : "medium",
			explanation: `The provider asked to start ${formatDuration(waited)} ago; the customer has not approved.`,
			at: new Date(since),
			link: { type: "booking", id: id(b._id) },
		});
	}

	for (const e of c.pendingEarnings) {
		const waited = n - time(e.createdAt);
		if (!(waited > t.earningReleaseGraceMs)) continue;
		items.push({
			kind: "earning_not_released",
			severity: "high",
			explanation: `Earning of ${money(e.amount)} not released ${formatDuration(waited)} after completion.`,
			at: new Date(e.createdAt),
			link: { type: "earning", id: id(e._id) },
		});
	}

	for (const p of c.failedPayouts) {
		const at = time(p.failedAt ?? p.updatedAt);
		if (!Number.isNaN(at) && n - at > t.failedLookbackMs) continue;
		items.push({
			kind: "payout_failed",
			severity: "high",
			explanation: `Payout of ${money(p.amount)} ${p.status === "cancelled" ? "was cancelled" : "failed"}; the amount went back to the provider's balance.`,
			at: new Date(Number.isNaN(at) ? n : at),
			link: { type: "payout", id: id(p._id) },
		});
	}

	for (const p of c.failedRefunds) {
		const at = time(p.updatedAt ?? p.refundCreated);
		if (!Number.isNaN(at) && n - at > t.failedLookbackMs) continue;
		items.push({
			kind: "refund_failed",
			severity: "high",
			explanation: `Refund of ${money(p.refundAmount)} ${p.refundStatus === "cancelled" ? "was cancelled" : "failed"} at Stripe; the customer has not been paid back.`,
			at: new Date(Number.isNaN(at) ? n : at),
			link: { type: "payment", id: id(p._id) },
		});
	}

	for (const a of c.pendingApplications) {
		const waited = n - time(a.createdAt);
		if (!(waited > t.applicationWaitMs)) continue;
		items.push({
			kind: "application_waiting",
			severity: waited > 7 * DAY ? "medium" : "low",
			explanation: `Provider application waiting ${formatDuration(waited)} for a review.`,
			at: new Date(a.createdAt),
			link: { type: "application", id: id(a._id) },
		});
	}

	const counts = {
		unassigned_near_start: 0,
		overdue_in_progress: 0,
		start_request_waiting: 0,
		earning_not_released: 0,
		payout_failed: 0,
		refund_failed: 0,
		application_waiting: 0,
	} as Record<AttentionKind, number>;
	for (const item of items) counts[item.kind]++;

	items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.at.getTime() - b.at.getTime());
	const kept: AttentionItem[] = [];
	const perKind = new Map<AttentionKind, number>();
	for (const item of items) {
		const count = perKind.get(item.kind) ?? 0;
		if (count >= t.perKind) continue;
		perKind.set(item.kind, count + 1);
		kept.push(item);
	}
	return { items: kept, counts };
};

// ---------------------------------------------------------------------------------------------------------------
// Coarse locations for the live map

/** Two decimal places: about 1.1 km north-south, less east-west. Enough for a map, never a doorstep. */
export const COARSE_DECIMALS = 2;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * A rounded copy of a position, or null when there is none (missing, out of range, or the 0,0 the app sends before it
 * has a fix). Rounding is to a fixed grid, so the same place always maps to the same point.
 */
export const coarseLocation = (latitude: unknown, longitude: unknown, decimals = COARSE_DECIMALS) => {
	if (!finite(latitude) || !finite(longitude)) return null;
	if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
	if (latitude === 0 && longitude === 0) return null;
	const factor = 10 ** decimals;
	const round = (v: number) => Math.round(v * factor) / factor;
	return { latitude: round(latitude), longitude: round(longitude), precisionKm: decimals >= 2 ? 1.1 : 11 };
};

// ---------------------------------------------------------------------------------------------------------------
// Refund amounts

export interface RefundablePayment {
	amount: number;
	status: string;
	paymentIntentId?: string | null;
	refundId?: string | null;
	refundStatus?: string | null;
	refundAmount?: number | null;
	refunds?: { amount: number; status: string; refundId?: string | null; idempotencyKey?: string }[] | null;
}

const COUNTED = new Set(["requested", "pending", "succeeded"]);

/**
 * What a payment has refunded or reserved for refund, in cents. Admin refunds are counted from `refunds` (requested,
 * pending and succeeded; a failed or cancelled one gives its amount back). A refund made by the cancellation or expiry
 * flow lives only in the top-level fields and is counted from there unless it failed.
 */
export const refundTotals = (payment: RefundablePayment) => {
	const paidCents = payment.status === "completed" ? toCents(payment.amount) : 0;
	const entries = payment.refunds ?? [];
	let committedCents = 0;
	let succeededCents = 0;
	for (const entry of entries) {
		if (COUNTED.has(entry.status)) committedCents += toCents(entry.amount);
		if (entry.status === "succeeded") succeededCents += toCents(entry.amount);
	}
	const legacy =
		!!payment.refundId &&
		!entries.some((entry) => entry.refundId === payment.refundId) &&
		payment.refundStatus !== "failed" &&
		payment.refundStatus !== "cancelled";
	if (legacy) {
		committedCents += toCents(payment.refundAmount ?? 0);
		if (payment.refundStatus === "succeeded") succeededCents += toCents(payment.refundAmount ?? 0);
	}
	return { paidCents, committedCents, succeededCents, remainingCents: Math.max(0, paidCents - committedCents) };
};

export type RefundPlan =
	| { ok: true; cents: number; partial: boolean; remainingAfterCents: number }
	| { ok: false; code: "not_paid" | "nothing_left" | "too_much" | "invalid_amount"; remainingCents: number };

/** How much a new refund may be: `requested` dollars, or everything left when omitted. Never more than is left. */
export const planRefund = (payment: RefundablePayment, requested?: number | null): RefundPlan => {
	const totals = refundTotals(payment);
	if (payment.status !== "completed" || !payment.paymentIntentId) {
		return { ok: false, code: "not_paid", remainingCents: 0 };
	}
	if (totals.remainingCents <= 0) return { ok: false, code: "nothing_left", remainingCents: 0 };
	let cents = totals.remainingCents;
	if (requested !== undefined && requested !== null) {
		if (!finite(requested) || requested <= 0 || Math.abs(requested * 100 - Math.round(requested * 100)) > 1e-6) {
			return { ok: false, code: "invalid_amount", remainingCents: totals.remainingCents };
		}
		cents = toCents(requested);
		if (cents > totals.remainingCents)
			return { ok: false, code: "too_much", remainingCents: totals.remainingCents };
	}
	return {
		ok: true,
		cents,
		partial: cents < totals.paidCents,
		remainingAfterCents: totals.remainingCents - cents,
	};
};
