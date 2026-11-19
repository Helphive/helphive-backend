// The analytics metrics layer: every metric defined once (what it means, its unit, how it is computed and which
// breakdowns it supports), and the builders that turn a definition, a range and a breakdown into one MongoDB
// aggregation pipeline. Pure: no database access here (controllers/admin/analytics.controller.ts runs the pipelines).
//
// Each aggregated metric reads one collection. Its pipeline matches an indexed date range, caps the documents it
// reads (MAX_SCAN), joins only what the requested breakdown needs, and groups by time bucket ($dateTrunc in the
// operator's zone, weeks from Monday) and breakdown key into "parts" (count n, numeric count c, sum s, denominator d,
// values for percentiles, distinct ids). The value of a bucket, and of the whole range, is computed from those parts,
// so a series and its total always agree.
import { EXPIRED_REASON, PROVIDER_SHARE } from "../operations";
import type { Interval } from "./periods";

export const MAX_SCAN = 100_000;
/** Breakdown series beyond this many become "Other". */
export const MAX_BREAKDOWN_SERIES = 8;

export const BREAKDOWNS = {
	service: "Service booked",
	platform: "App platform (from request context; recorded from this release on)",
	city: "Customer's city as typed on their profile (lower-cased)",
	status: "Current booking status",
	cancelledBy: "Who cancelled (customer, provider or admin)",
	stage: "Whether a provider had accepted when it was cancelled",
	reason: "Cancellation reason text (the apps do not ask for one today; expiries are separate)",
	appVersion: "App version (from request context)",
	role: "Customer or provider",
	decision: "Application decision",
} as const;
export type Breakdown = keyof typeof BREAKDOWNS;

export const UNITS = ["count", "money", "percent", "duration", "hours", "number"] as const;
export type Unit = (typeof UNITS)[number];

export const GROUPS = ["bookings", "revenue", "health", "customers", "providers", "platform"] as const;
export type Group = (typeof GROUPS)[number];

type Op = "count" | "sum" | "mean" | "ratio" | "dist" | "distinct" | "perDistinct";

type Expr = unknown;

interface SourceSpec {
	collection: "bookings" | "payments" | "earnings" | "users" | "events" | "providerapplications";
	/** Date field the range applies to; `fallback` is used when it is missing (older records). */
	date: string;
	fallback?: string;
	match?: Record<string, unknown>;
}

export interface AggregateMetric {
	kind: "aggregate";
	id: string;
	label: string;
	description: string;
	computation: string;
	group: Group;
	unit: Unit;
	/** Which direction is good (for delta colour). */
	good: "up" | "down" | "neutral";
	source: SourceSpec;
	op: Op;
	/** Per-document value (sum, mean, dist, ratio numerator). */
	value?: Expr;
	/** Ratio denominator per document. */
	den?: Expr;
	/** Distinct id per document (distinct, perDistinct). */
	distinctOf?: Expr;
	/** Multiply the final value (e.g. 100 for percentages). */
	scale?: number;
	breakdowns: readonly Breakdown[];
	/** Operations list this metric drills into: path and fixed filters; the range is added as from/to. */
	drill?: { path: string; params?: Record<string, string>; dateParams?: [string, string] };
	note?: string;
}

export interface DerivedMetric {
	kind: "derived";
	id: string;
	label: string;
	description: string;
	computation: string;
	group: Group;
	unit: Unit;
	good: "up" | "down" | "neutral";
	of: readonly string[];
	/** Combines the inputs' values (per bucket and for the total); null when undefined (e.g. divide by zero). */
	combine: (values: (number | null)[], context: { approvedProviders?: number }) => number | null;
	breakdowns: readonly Breakdown[];
	note?: string;
}

export interface CustomMetric {
	kind: "custom";
	id: string;
	label: string;
	description: string;
	computation: string;
	group: Group;
	unit: Unit;
	good: "up" | "down" | "neutral";
	breakdowns: readonly Breakdown[];
	note?: string;
}

export type MetricDef = AggregateMetric | DerivedMetric | CustomMetric;

// ---------------------------------------------------------------------------------------------------------------
// Expressions shared by several metrics

const BOOKING_AMOUNT = { $multiply: [{ $ifNull: ["$rate", 0] }, { $ifNull: ["$hours", 0] }] };
const isNullish = (field: string) => ({ $in: [{ $ifNull: [field, null] }, [null, ""]] });
/** A cancelled booking that expired (no provider before the start): the task's reason, or a legacy expiry. */
const IS_EXPIRED = {
	$and: [
		{ $eq: ["$status", "cancelled"] },
		{
			$or: [
				{ $eq: ["$cancellationReason", EXPIRED_REASON] },
				{
					$and: [
						isNullish("$cancellationReason"),
						{ $eq: [{ $ifNull: ["$providerId", null] }, null] },
						{ $gte: ["$cancelledAt", "$startDate"] },
					],
				},
			],
		},
	],
};
const IS_CANCELLED = { $and: [{ $eq: ["$status", "cancelled"] }, { $not: [IS_EXPIRED] }] };
const HAS_PROVIDER = { $ne: [{ $ifNull: ["$providerId", null] }, null] };
const LEGACY_EXPIRY_MATCH = {
	cancellationReason: { $in: [null, ""] },
	providerId: null,
	$expr: { $gte: ["$cancelledAt", "$startDate"] },
};
const bool = (expr: Expr) => ({ $cond: [expr, 1, 0] });
const ms = (later: string, earlier: string) => ({
	$cond: [
		{ $and: [{ $eq: [{ $type: later }, "date"] }, { $eq: [{ $type: earlier }, "date"] }] },
		{ $subtract: [later, earlier] },
		null,
	],
});

const BOOKING_BREAKDOWNS = ["service", "city", "status", "platform"] as const;
const PAYMENT_BREAKDOWNS = ["service", "city"] as const;

// ---------------------------------------------------------------------------------------------------------------
// The metrics

const agg = (def: Omit<AggregateMetric, "kind">): AggregateMetric => ({ kind: "aggregate", ...def });

export const METRICS: readonly MetricDef[] = [
	// Bookings
	agg({
		id: "bookings_created",
		label: "Bookings created",
		description: "Bookings customers created, paid or not.",
		computation: "Count of bookings by createdAt.",
		group: "bookings",
		unit: "count",
		good: "up",
		source: { collection: "bookings", date: "createdAt" },
		op: "count",
		breakdowns: BOOKING_BREAKDOWNS,
		drill: { path: "/bookings" },
	}),
	agg({
		id: "bookings_paid",
		label: "Bookings paid",
		description: "Payments Stripe confirmed (one per paid booking).",
		computation: "Count of completed payments by paidAt (older payments: createdAt).",
		group: "bookings",
		unit: "count",
		good: "up",
		source: { collection: "payments", date: "paidAt", fallback: "createdAt", match: { status: "completed" } },
		op: "count",
		breakdowns: PAYMENT_BREAKDOWNS,
		drill: { path: "/payments", params: { status: "completed" } },
	}),
	agg({
		id: "bookings_accepted",
		label: "Bookings accepted",
		description: "Bookings a provider accepted.",
		computation: "Count of bookings by acceptedAt.",
		group: "bookings",
		unit: "count",
		good: "up",
		source: { collection: "bookings", date: "acceptedAt" },
		op: "count",
		breakdowns: ["service", "city", "status"],
		note: "acceptedAt is recorded from the event-stream release on; earlier acceptances have no time.",
	}),
	agg({
		id: "bookings_completed",
		label: "Bookings completed",
		description: "Jobs marked complete by the customer, the provider or an admin.",
		computation: "Count of completed bookings by completedAt.",
		group: "bookings",
		unit: "count",
		good: "up",
		source: { collection: "bookings", date: "completedAt", match: { status: "completed" } },
		op: "count",
		breakdowns: ["service", "city", "platform"],
		drill: {
			path: "/bookings",
			params: { status: "completed" },
			dateParams: ["completedFrom", "completedTo"],
		},
	}),
	agg({
		id: "bookings_cancelled",
		label: "Bookings cancelled",
		description: "Cancellations by a customer, a provider or an admin (expiries are counted separately).",
		computation: "Count of booking.cancelled events by time.",
		group: "bookings",
		unit: "count",
		good: "down",
		source: { collection: "events", date: "at", match: { type: "booking.cancelled" } },
		op: "count",
		breakdowns: ["cancelledBy", "stage", "reason", "service", "platform"],
		drill: { path: "/bookings", params: { displayStatus: "cancelled" } },
		note: "The bookings list filters by creation date, so the drill-through shows bookings created in the range.",
	}),
	agg({
		id: "bookings_expired",
		label: "Bookings expired",
		description: "Bookings nobody accepted before the start time (cancelled and refunded automatically).",
		computation: "Count of expired bookings by cancelledAt.",
		group: "bookings",
		unit: "count",
		good: "down",
		source: {
			collection: "bookings",
			date: "cancelledAt",
			match: { status: "cancelled", $or: [{ cancellationReason: EXPIRED_REASON }, LEGACY_EXPIRY_MATCH] },
		},
		op: "count",
		breakdowns: ["service", "city"],
		drill: { path: "/bookings", params: { displayStatus: "expired" } },
	}),
	agg({
		id: "booked_hours",
		label: "Hours booked",
		description: "Hours of work in the bookings created.",
		computation: "Sum of hours over bookings by createdAt.",
		group: "bookings",
		unit: "hours",
		good: "up",
		source: { collection: "bookings", date: "createdAt" },
		op: "sum",
		value: "$hours",
		breakdowns: BOOKING_BREAKDOWNS,
	}),
	agg({
		id: "avg_booking_value",
		label: "Average booking value",
		description: "Rate times hours, averaged over the bookings created.",
		computation: "Mean of rate x hours over bookings by createdAt.",
		group: "bookings",
		unit: "money",
		good: "up",
		source: { collection: "bookings", date: "createdAt" },
		op: "mean",
		value: BOOKING_AMOUNT,
		breakdowns: BOOKING_BREAKDOWNS,
	}),
	agg({
		id: "avg_hours",
		label: "Average hours per booking",
		description: "Hours booked per booking.",
		computation: "Mean of hours over bookings by createdAt.",
		group: "bookings",
		unit: "hours",
		good: "neutral",
		source: { collection: "bookings", date: "createdAt" },
		op: "mean",
		value: "$hours",
		breakdowns: BOOKING_BREAKDOWNS,
	}),
	agg({
		id: "avg_hourly_rate",
		label: "Average hourly rate",
		description: "The hourly rate customers booked at.",
		computation: "Mean of rate over bookings by createdAt.",
		group: "bookings",
		unit: "money",
		good: "neutral",
		source: { collection: "bookings", date: "createdAt" },
		op: "mean",
		value: "$rate",
		breakdowns: BOOKING_BREAKDOWNS,
	}),

	// Revenue
	agg({
		id: "paid_value",
		label: "Paid value",
		description: "Money customers paid (gross booking value taken).",
		computation: "Sum of amount over completed payments by paidAt (older payments: createdAt).",
		group: "revenue",
		unit: "money",
		good: "up",
		source: { collection: "payments", date: "paidAt", fallback: "createdAt", match: { status: "completed" } },
		op: "sum",
		value: "$amount",
		breakdowns: PAYMENT_BREAKDOWNS,
		drill: { path: "/payments", params: { status: "completed" } },
	}),
	agg({
		id: "completed_value",
		label: "Completed value",
		description: "Value of the jobs completed.",
		computation: "Sum of rate x hours over completed bookings by completedAt.",
		group: "revenue",
		unit: "money",
		good: "up",
		source: { collection: "bookings", date: "completedAt", match: { status: "completed" } },
		op: "sum",
		value: BOOKING_AMOUNT,
		breakdowns: ["service", "city"],
		drill: {
			path: "/bookings",
			params: { status: "completed" },
			dateParams: ["completedFrom", "completedTo"],
		},
	}),
	agg({
		id: "platform_fees",
		label: "Platform fees",
		description: `The platform's ${Math.round((1 - PROVIDER_SHARE) * 100)} % of each completed job.`,
		computation: "Sum over earnings (not cancelled) by createdAt of amount x (1 - share) / share.",
		group: "revenue",
		unit: "money",
		good: "up",
		source: { collection: "earnings", date: "createdAt", match: { status: { $ne: "cancelled" } } },
		op: "sum",
		value: { $multiply: ["$amount", (1 - PROVIDER_SHARE) / PROVIDER_SHARE] },
		breakdowns: ["service"],
	}),
	agg({
		id: "provider_earnings",
		label: "Provider earnings",
		description: "What providers earned from completed jobs.",
		computation: "Sum of amount over earnings (not cancelled) by createdAt.",
		group: "revenue",
		unit: "money",
		good: "up",
		source: { collection: "earnings", date: "createdAt", match: { status: { $ne: "cancelled" } } },
		op: "sum",
		value: "$amount",
		breakdowns: ["service"],
		drill: { path: "/earnings" },
	}),
	agg({
		id: "refunds",
		label: "Refunds",
		description: "Money returned to customers (cancellations, expiries and admin refunds).",
		computation:
			"Sum of refundAmount (total refunded on the payment) over payments with a pending or succeeded refund, by refundCreated.",
		group: "revenue",
		unit: "money",
		good: "down",
		source: {
			collection: "payments",
			date: "refundCreated",
			match: { refundId: { $type: "string" }, refundStatus: { $in: ["pending", "succeeded"] } },
		},
		op: "sum",
		value: "$refundAmount",
		breakdowns: PAYMENT_BREAKDOWNS,
		drill: { path: "/payments", params: { refundState: "any" } },
		note: "Several admin refunds on one payment count at the time of the latest one.",
	}),
	agg({
		id: "refund_count",
		label: "Payments refunded",
		description: "Payments with a pending or succeeded refund.",
		computation: "Count of payments with a pending or succeeded refund, by refundCreated.",
		group: "revenue",
		unit: "count",
		good: "down",
		source: {
			collection: "payments",
			date: "refundCreated",
			match: { refundId: { $type: "string" }, refundStatus: { $in: ["pending", "succeeded"] } },
		},
		op: "count",
		breakdowns: PAYMENT_BREAKDOWNS,
		drill: { path: "/payments", params: { refundState: "any" } },
	}),
	{
		kind: "derived",
		id: "take_rate",
		label: "Take rate",
		description: "Platform fees as a share of completed value.",
		computation: "platform_fees / completed_value x 100.",
		group: "revenue",
		unit: "percent",
		good: "up",
		of: ["platform_fees", "completed_value"],
		combine: ([fees, value]) => (fees === null || !value ? null : (fees / value) * 100),
		breakdowns: [],
	},
	{
		kind: "derived",
		id: "net_revenue",
		label: "Net revenue",
		description: "Cash the platform kept: paid in, less refunds, less provider earnings.",
		computation: "paid_value - refunds - provider_earnings (cash basis: each part counted when it happened).",
		group: "revenue",
		unit: "money",
		good: "up",
		of: ["paid_value", "refunds", "provider_earnings"],
		combine: ([paid, refunds, earnings]) => (paid ?? 0) - (refunds ?? 0) - (earnings ?? 0),
		breakdowns: [],
		note: "A booking paid in one period and completed in the next adds to the first and subtracts in the second.",
	},

	// Marketplace health
	agg({
		id: "fill_rate",
		label: "Fill rate",
		description: "Paid bookings that got a provider, of those that were decided (filled or expired).",
		computation:
			"By startDate, over paid bookings: those with a provider / (with a provider + expired). Bookings still open and cancellations before acceptance are left out.",
		group: "health",
		unit: "percent",
		good: "up",
		source: { collection: "bookings", date: "startDate" },
		op: "ratio",
		value: bool(HAS_PROVIDER),
		den: bool({ $or: [HAS_PROVIDER, IS_EXPIRED] }),
		scale: 100,
		breakdowns: ["service", "city"],
	}),
	agg({
		id: "time_to_accept",
		label: "Time to accept",
		description: "From booking created to a provider accepting it.",
		computation: "acceptedAt - createdAt over bookings by acceptedAt; median and 90th percentile.",
		group: "health",
		unit: "duration",
		good: "down",
		source: { collection: "bookings", date: "acceptedAt" },
		op: "dist",
		value: ms("$acceptedAt", "$createdAt"),
		breakdowns: ["service", "city"],
		note: "Only acceptances since acceptedAt was recorded.",
	}),
	agg({
		id: "time_to_start",
		label: "Start delay",
		description: "From the booked start time to the job actually starting (negative: started early).",
		computation: "startedAt - startDate over bookings by startedAt; median and 90th percentile.",
		group: "health",
		unit: "duration",
		good: "down",
		source: { collection: "bookings", date: "startedAt" },
		op: "dist",
		value: ms("$startedAt", "$startDate"),
		breakdowns: ["service", "city"],
	}),
	agg({
		id: "time_to_complete",
		label: "Time to complete",
		description: "From the job starting to it being marked complete.",
		computation: "completedAt - startedAt over completed bookings by completedAt; median and 90th percentile.",
		group: "health",
		unit: "duration",
		good: "neutral",
		source: { collection: "bookings", date: "completedAt", match: { status: "completed" } },
		op: "dist",
		value: ms("$completedAt", "$startedAt"),
		breakdowns: ["service", "city"],
	}),
	agg({
		id: "cancellation_rate",
		label: "Cancellation rate",
		description: "Bookings created in the period that were later cancelled (not expired).",
		computation: "Cancelled (not expired) / all bookings, by createdAt.",
		group: "health",
		unit: "percent",
		good: "down",
		source: { collection: "bookings", date: "createdAt" },
		op: "ratio",
		value: bool(IS_CANCELLED),
		den: 1,
		scale: 100,
		breakdowns: ["service", "city", "platform"],
	}),
	agg({
		id: "expiry_rate",
		label: "Expiry rate",
		description: "Bookings created in the period that expired without a provider.",
		computation: "Expired / all bookings, by createdAt.",
		group: "health",
		unit: "percent",
		good: "down",
		source: { collection: "bookings", date: "createdAt" },
		op: "ratio",
		value: bool(IS_EXPIRED),
		den: 1,
		scale: 100,
		breakdowns: ["service", "city"],
	}),

	// Customers
	agg({
		id: "new_customers",
		label: "New customers",
		description: "Customer accounts created.",
		computation: "Count of users with the customer role by createdAt.",
		group: "customers",
		unit: "count",
		good: "up",
		source: { collection: "users", date: "createdAt", match: { "roles.User": true } },
		op: "count",
		breakdowns: ["city", "platform"],
		drill: { path: "/users", params: { role: "customer" } },
	}),
	agg({
		id: "active_customers",
		label: "Active customers",
		description: "Distinct customers who did anything recorded in the event stream (sign in, book, pay...).",
		computation: "Distinct actor ids of events whose actor is a customer, per bucket.",
		group: "customers",
		unit: "count",
		good: "up",
		source: { collection: "events", date: "at", match: { "actor.type": "user" } },
		op: "distinct",
		distinctOf: "$actor.id",
		breakdowns: ["platform"],
		note: "Token refreshes are not events, so someone who only opened the app is not counted.",
	}),
	{
		kind: "custom",
		id: "repeat_booking_rate",
		label: "Repeat-booking rate",
		description: "Customers who booked in the period and had booked before (or booked twice in it).",
		computation:
			"Per bucket: customers with a booking created in it whose first booking ever is earlier, or who created two or more in it / customers with a booking created in it.",
		group: "customers",
		unit: "percent",
		good: "up",
		breakdowns: [],
	},
	agg({
		id: "sign_ins",
		label: "Sign-ins",
		description: "Successful customer and provider sign-ins.",
		computation: "Count of auth.sign_in_succeeded events.",
		group: "platform",
		unit: "count",
		good: "up",
		source: { collection: "events", date: "at", match: { type: "auth.sign_in_succeeded" } },
		op: "count",
		breakdowns: ["platform", "appVersion", "role"],
	}),
	agg({
		id: "active_devices",
		label: "Active devices",
		description: "Distinct app installs seen in the event stream.",
		computation: "Distinct context.deviceId of events, per bucket.",
		group: "platform",
		unit: "count",
		good: "up",
		source: { collection: "events", date: "at", match: { "context.deviceId": { $exists: true } } },
		op: "distinct",
		distinctOf: "$context.deviceId",
		breakdowns: ["platform", "appVersion"],
		note: "Recorded from this release on; only app builds that send X-Device-Id.",
	}),

	// Providers
	agg({
		id: "new_providers",
		label: "New providers",
		description: "Provider accounts created.",
		computation: "Count of users with the provider role by createdAt.",
		group: "providers",
		unit: "count",
		good: "up",
		source: { collection: "users", date: "createdAt", match: { "roles.Provider": true } },
		op: "count",
		breakdowns: ["city", "platform"],
		drill: { path: "/users", params: { role: "provider" } },
	}),
	agg({
		id: "active_providers",
		label: "Active providers",
		description: "Distinct providers who did anything recorded in the event stream.",
		computation: "Distinct actor ids of events whose actor is a provider, per bucket.",
		group: "providers",
		unit: "count",
		good: "up",
		source: { collection: "events", date: "at", match: { "actor.type": "provider" } },
		op: "distinct",
		distinctOf: "$actor.id",
		breakdowns: ["platform"],
	}),
	agg({
		id: "working_providers",
		label: "Working providers",
		description: "Distinct providers who completed at least one job.",
		computation: "Distinct providerId of completed bookings by completedAt, per bucket.",
		group: "providers",
		unit: "count",
		good: "up",
		source: { collection: "bookings", date: "completedAt", match: { status: "completed" } },
		op: "distinct",
		distinctOf: "$providerId",
		breakdowns: ["service"],
	}),
	agg({
		id: "hours_per_provider",
		label: "Hours per working provider",
		description: "Hours of completed jobs per provider who worked.",
		computation: "Sum of hours of completed bookings / distinct providers, by completedAt.",
		group: "providers",
		unit: "hours",
		good: "up",
		source: { collection: "bookings", date: "completedAt", match: { status: "completed" } },
		op: "perDistinct",
		value: "$hours",
		distinctOf: "$providerId",
		breakdowns: ["service"],
	}),
	{
		kind: "derived",
		id: "provider_utilisation",
		label: "Provider utilisation",
		description: "Approved providers who completed at least one job in the period.",
		computation: "working_providers / approved providers today x 100.",
		group: "providers",
		unit: "percent",
		good: "up",
		of: ["working_providers"],
		combine: ([working], { approvedProviders }) =>
			working === null || !approvedProviders ? null : (working / approvedProviders) * 100,
		breakdowns: [],
		note: "Approval dates are not stored on the user, so the denominator is today's approved providers.",
	},
	agg({
		id: "applications_received",
		label: "Applications received",
		description: "Provider applications submitted.",
		computation: "Count of provider applications by createdAt.",
		group: "providers",
		unit: "count",
		good: "up",
		source: { collection: "providerapplications", date: "createdAt" },
		op: "count",
		breakdowns: ["decision"],
		drill: { path: "/applications" },
	}),
	agg({
		id: "applications_approved",
		label: "Applications approved",
		description: "Provider applications approved.",
		computation: "Count of provider.application_reviewed events with decision approved.",
		group: "providers",
		unit: "count",
		good: "up",
		source: {
			collection: "events",
			date: "at",
			match: { type: "provider.application_reviewed", "properties.decision": "approved" },
		},
		op: "count",
		breakdowns: [],
	}),
	agg({
		id: "applications_rejected",
		label: "Applications rejected",
		description: "Provider applications rejected.",
		computation: "Count of provider.application_reviewed events with decision rejected.",
		group: "providers",
		unit: "count",
		good: "neutral",
		source: {
			collection: "events",
			date: "at",
			match: { type: "provider.application_reviewed", "properties.decision": "rejected" },
		},
		op: "count",
		breakdowns: [],
	}),
	agg({
		id: "time_to_review",
		label: "Time to review",
		description: "From an application being submitted to its decision.",
		computation: "properties.waitedMs of provider.application_reviewed events; median and 90th percentile.",
		group: "providers",
		unit: "duration",
		good: "down",
		source: { collection: "events", date: "at", match: { type: "provider.application_reviewed" } },
		op: "dist",
		value: "$properties.waitedMs",
		breakdowns: ["decision"],
		note: "Backfilled decisions without a stored review time use the application's last update (approximate).",
	}),
];

export const METRIC_IDS = METRICS.map((m) => m.id);
export const metricById = (id: string) => METRICS.find((m) => m.id === id);

// ---------------------------------------------------------------------------------------------------------------
// Breakdown expressions and the joins they need, per collection

const SERVICE_NAMES: Record<number, string> = { 1: "Public Area Attendant", 2: "Room Attendant", 3: "Linen Porter" };
const serviceName = (idExpr: Expr) => ({
	$switch: {
		branches: Object.entries(SERVICE_NAMES).map(([id, name]) => ({
			case: { $eq: [idExpr, Number(id)] },
			then: name,
		})),
		default: "Unknown",
	},
});
const cityKey = (expr: Expr) => ({
	$let: {
		vars: { c: { $toLower: { $trim: { input: { $ifNull: [expr, ""] } } } } },
		in: { $cond: [{ $eq: ["$$c", ""] }, "unknown", { $substrCP: ["$$c", 0, 40] }] },
	},
});
const textKey = (expr: Expr, empty = "unknown") => ({
	$let: {
		vars: { v: { $ifNull: [expr, null] } },
		in: {
			$cond: [
				{ $or: [{ $eq: ["$$v", null] }, { $eq: ["$$v", ""] }] },
				empty,
				{ $substrCP: [{ $toString: "$$v" }, 0, 60] },
			],
		},
	},
});
const BOOKING_STATUS = {
	$switch: {
		branches: [
			{ case: { $eq: ["$status", "completed"] }, then: "completed" },
			{ case: { $eq: ["$status", "in progress"] }, then: "in_progress" },
			{ case: IS_EXPIRED, then: "expired" },
			{ case: { $eq: ["$status", "cancelled"] }, then: "cancelled" },
			{ case: HAS_PROVIDER, then: "accepted" },
		],
		default: "open",
	},
};

const lookupOne = (from: string, localField: string, foreignField: string, as: string, project: object) => [
	{ $lookup: { from, localField, foreignField, as, pipeline: [{ $project: project }, { $limit: 1 }] } },
	{ $set: { [as]: { $first: `$${as}` } } },
];
const lookupEventPlatform = (localField: string, foreignField: string, type: string) => [
	{
		$lookup: {
			from: "events",
			localField,
			foreignField,
			as: "_ev",
			pipeline: [{ $match: { type } }, { $project: { p: "$context.platform" } }, { $limit: 1 }],
		},
	},
	{ $set: { _platform: { $first: "$_ev.p" } } },
];

interface BreakdownPlan {
	stages: object[];
	key: Expr;
}

/** How to key a document of `collection` by `breakdown`, and the joins needed first. Null if unsupported. */
export const breakdownPlan = (collection: SourceSpec["collection"], breakdown: Breakdown): BreakdownPlan | null => {
	switch (collection) {
		case "bookings":
			if (breakdown === "service") return { stages: [], key: serviceName("$service.id") };
			if (breakdown === "status") return { stages: [], key: BOOKING_STATUS };
			if (breakdown === "city")
				return { stages: lookupOne("users", "userId", "_id", "_u", { city: 1 }), key: cityKey("$_u.city") };
			if (breakdown === "platform")
				return {
					stages: lookupEventPlatform("_id", "bookingId", "booking.created"),
					key: textKey("$_platform"),
				};
			return null;
		case "payments":
		case "earnings": {
			const booking = lookupOne("bookings", "bookingId", "_id", "_b", { service: 1, userId: 1 });
			if (breakdown === "service") return { stages: booking, key: serviceName("$_b.service.id") };
			if (breakdown === "city" && collection === "payments")
				return {
					stages: [...booking, ...lookupOne("users", "_b.userId", "_id", "_u", { city: 1 })],
					key: cityKey("$_u.city"),
				};
			return null;
		}
		case "users":
			if (breakdown === "city") return { stages: [], key: cityKey("$city") };
			if (breakdown === "platform")
				return { stages: lookupEventPlatform("_id", "userId", "user.signed_up"), key: textKey("$_platform") };
			return null;
		case "providerapplications":
			if (breakdown === "decision") return { stages: [], key: textKey("$status") };
			return null;
		case "events":
			if (breakdown === "platform") return { stages: [], key: textKey("$context.platform") };
			if (breakdown === "appVersion") return { stages: [], key: textKey("$context.appVersion") };
			if (breakdown === "role") return { stages: [], key: textKey("$properties.role") };
			if (breakdown === "cancelledBy") return { stages: [], key: textKey("$properties.by") };
			if (breakdown === "decision") return { stages: [], key: textKey("$properties.decision") };
			if (breakdown === "reason") return { stages: [], key: textKey("$properties.reason", "none given") };
			if (breakdown === "stage")
				return {
					stages: [],
					key: {
						$cond: [
							{ $eq: ["$properties.wasInProgress", true] },
							"in progress",
							{
								$cond: [
									{ $eq: ["$properties.wasAccepted", true] },
									"after acceptance",
									"before acceptance",
								],
							},
						],
					},
				};
			if (breakdown === "service")
				return {
					stages: lookupOne("bookings", "bookingId", "_id", "_b", { service: 1 }),
					key: serviceName("$_b.service.id"),
				};
			return null;
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Pipeline builders

export interface PipelineInput {
	start: Date;
	end: Date;
	interval: Interval;
	tz: string;
	breakdown?: Breakdown | null;
	/** For "only bookings that were paid" (fill rate). */
	now?: Date;
}

/** The $match on the source's date range (with the fallback field for older records) and its fixed filters. */
export const rangeMatch = (source: SourceSpec, start: Date, end: Date) => {
	const range = { $gte: start, $lt: end };
	const base = { ...(source.match ?? {}) };
	if (!source.fallback) return { ...base, [source.date]: range };
	const dateOr = [{ [source.date]: range }, { [source.date]: null, [source.fallback]: range }];
	// The source match may already use $or (expired bookings); combine both with $and.
	return "$or" in base ? { $and: [base, { $or: dateOr }] } : { ...base, $or: dateOr };
};

export const dateExpr = (source: SourceSpec) =>
	source.fallback ? { $ifNull: [`$${source.date}`, `$${source.fallback}`] } : `$${source.date}`;

/** Extra stages for a metric's own semantics (fill rate counts only paid bookings, decided ones). */
const metricStages = (def: AggregateMetric, input: PipelineInput): object[] => {
	if (def.id !== "fill_rate") return [];
	return [
		{
			$lookup: {
				from: "payments",
				localField: "_id",
				foreignField: "bookingId",
				as: "_paid",
				pipeline: [{ $match: { status: "completed" } }, { $project: { _id: 1 } }, { $limit: 1 }],
			},
		},
		{ $match: { "_paid.0": { $exists: true } } },
		// Still open (no provider, start ahead) is undecided.
		{
			$match: {
				$expr: {
					$not: [
						{
							$and: [
								{ $eq: ["$status", "pending"] },
								{ $eq: [{ $ifNull: ["$providerId", null] }, null] },
								{ $gte: ["$startDate", input.now ?? new Date()] },
							],
						},
					],
				},
			},
		},
	];
};

/**
 * The pipeline for one aggregated metric: one document per (bucket start, breakdown key) with the parts its value
 * is computed from. `bucketed: false` groups the whole range into one row per key (for totals of distinct counts).
 */
export const buildSeriesPipeline = (def: AggregateMetric, input: PipelineInput, bucketed = true): object[] => {
	const plan = input.breakdown ? breakdownPlan(def.source.collection, input.breakdown) : null;
	if (input.breakdown && !plan) throw new Error(`${def.id} has no ${input.breakdown} breakdown`);
	const project: Record<string, unknown> = {
		_id: 0,
		t: bucketed
			? {
					$dateTrunc: {
						date: dateExpr(def.source),
						unit: input.interval,
						timezone: input.tz,
						...(input.interval === "week" ? { startOfWeek: "monday" } : {}),
					},
				}
			: null,
		k: plan ? plan.key : null,
	};
	if (def.value !== undefined) project.v = def.value;
	if (def.den !== undefined) project.d = def.den;
	if (def.distinctOf !== undefined) project.i = def.distinctOf;

	const group: Record<string, unknown> = { _id: { t: "$t", k: "$k" }, n: { $sum: 1 } };
	if (def.op === "sum" || def.op === "mean" || def.op === "ratio" || def.op === "perDistinct")
		group.s = { $sum: "$v" };
	if (def.op === "mean") group.c = { $sum: { $cond: [{ $isNumber: "$v" }, 1, 0] } };
	if (def.op === "ratio") group.d = { $sum: "$d" };
	if (def.op === "dist") group.vals = { $push: "$v" };
	if (def.op === "distinct" || def.op === "perDistinct") group.ids = { $addToSet: "$i" };

	return [
		{ $match: rangeMatch(def.source, input.start, input.end) },
		{ $limit: MAX_SCAN },
		...metricStages(def, input),
		...(plan?.stages ?? []),
		{ $project: project },
		{ $group: group },
		{ $project: { _id: 0, t: "$_id.t", k: "$_id.k", n: 1, s: 1, c: 1, d: 1, vals: 1, ids: 1 } },
	];
};
