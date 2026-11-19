// Pipeline builders for the analytics reports beyond time series (pure): funnels, retention cohorts, the
// supply-and-demand grids, leaderboards, distributions and the repeat-booking input. Each starts with an indexed
// $match on a bounded range and a $limit of MAX_SCAN documents.
import { MAX_SCAN } from "./metrics";
import type { FunnelStep } from "./stats";

const SERVICE_IDS = { "Public Area Attendant": 1, "Room Attendant": 2, "Linen Porter": 3 } as const;
export const SERVICES = Object.entries(SERVICE_IDS).map(([name, id]) => ({ id, name }));

const paidDate = { $ifNull: ["$paidAt", "$createdAt"] };
const paidBefore = (end: Date) => ({
	status: "completed",
	$or: [{ paidAt: { $lt: end } }, { paidAt: null, createdAt: { $lt: end } }],
});
const paidWithin = (start: Date, end: Date) => ({
	status: "completed",
	$or: [{ paidAt: { $gte: start, $lt: end } }, { paidAt: null, createdAt: { $gte: start, $lt: end } }],
});
const range = (start: Date, end: Date) => ({ $gte: start, $lt: end });
const bookingOf = (project: object) => [
	{
		$lookup: {
			from: "bookings",
			localField: "bookingId",
			foreignField: "_id",
			as: "_b",
			pipeline: [{ $project: project }, { $limit: 1 }],
		},
	},
	{ $set: { _b: { $first: "$_b" } } },
];

// ---------------------------------------------------------------------------------------------------------------
// Funnels: who signed up in the range, and how far each got (to date). Strict: a step counts only after every
// step before it (stats.funnel).

export const CUSTOMER_FUNNEL: FunnelStep[] = [
	{ id: "signed_up", label: "Signed up" },
	{ id: "verified", label: "Verified email" },
	{ id: "first_booking", label: "Created a booking" },
	{ id: "paid", label: "Paid for a booking" },
	{ id: "completed", label: "Had a booking completed" },
	{ id: "second_booking", label: "Created a second booking" },
];

export const PROVIDER_FUNNEL: FunnelStep[] = [
	{ id: "signed_up", label: "Signed up" },
	{ id: "applied", label: "Applied" },
	{ id: "approved", label: "Approved" },
	{ id: "first_accepted", label: "Accepted a job" },
	{ id: "first_completed", label: "Completed a job" },
];

export const customerFunnelPipeline = (start: Date, end: Date) => [
	{ $match: { "roles.User": true, createdAt: range(start, end) } },
	{ $limit: MAX_SCAN },
	{
		$lookup: {
			from: "bookings",
			localField: "_id",
			foreignField: "userId",
			as: "bk",
			pipeline: [{ $project: { _id: 1, status: 1 } }, { $limit: 50 }],
		},
	},
	{
		$lookup: {
			from: "payments",
			localField: "bk._id",
			foreignField: "bookingId",
			as: "pd",
			pipeline: [{ $match: { status: "completed" } }, { $project: { _id: 1 } }, { $limit: 1 }],
		},
	},
	{
		$project: {
			r: [
				true,
				{ $eq: ["$isEmailVerified", true] },
				{ $gt: [{ $size: "$bk" }, 0] },
				{ $gt: [{ $size: "$pd" }, 0] },
				{ $in: ["completed", "$bk.status"] },
				{ $gte: [{ $size: "$bk" }, 2] },
			],
		},
	},
	{ $group: { _id: "$r", count: { $sum: 1 } } },
	{ $project: { _id: 0, reached: "$_id", count: 1 } },
];

export const providerFunnelPipeline = (start: Date, end: Date) => [
	{ $match: { "roles.Provider": true, createdAt: range(start, end) } },
	{ $limit: MAX_SCAN },
	{
		$lookup: {
			from: "bookings",
			localField: "_id",
			foreignField: "providerId",
			as: "jobs",
			pipeline: [{ $project: { _id: 0, status: 1 } }, { $limit: 50 }],
		},
	},
	{
		$project: {
			r: [
				true,
				{
					$or: [
						{ $gt: [{ $size: { $ifNull: ["$providerApplications", []] } }, 0] },
						{ $in: ["$providerStatus", ["pending", "approved", "rejected"]] },
					],
				},
				{ $eq: ["$providerStatus", "approved"] },
				{ $gt: [{ $size: "$jobs" }, 0] },
				{ $in: ["completed", "$jobs.status"] },
			],
		},
	},
	{ $group: { _id: "$r", count: { $sum: 1 } } },
	{ $project: { _id: 0, reached: "$_id", count: 1 } },
];

// ---------------------------------------------------------------------------------------------------------------
// Retention cohorts: (subject, month) activity pairs up to the end of the range; the first month decides the cohort.

/** Customers active = a paid booking (by paid date), months in `tz`. */
export const customerCohortPipeline = (end: Date, tz: string) => [
	{ $match: paidBefore(end) },
	{ $limit: MAX_SCAN },
	...bookingOf({ userId: 1 }),
	{
		$group: {
			_id: { id: "$_b.userId", m: { $dateToString: { format: "%Y-%m", date: paidDate, timezone: tz } } },
		},
	},
	{ $match: { "_id.id": { $ne: null } } },
	{ $project: { _id: 0, id: { $toString: "$_id.id" }, month: "$_id.m" } },
];

/** Providers active = a completed job (by completedAt), months in `tz`. */
export const providerCohortPipeline = (end: Date, tz: string) => [
	{ $match: { status: "completed", completedAt: { $lt: end }, providerId: { $ne: null } } },
	{ $limit: MAX_SCAN },
	{
		$group: {
			_id: {
				id: "$providerId",
				m: { $dateToString: { format: "%Y-%m", date: "$completedAt", timezone: tz } },
			},
		},
	},
	{ $project: { _id: 0, id: { $toString: "$_id.id" }, month: "$_id.m" } },
];

// ---------------------------------------------------------------------------------------------------------------
// Supply and demand

const serviceMatch = (serviceId: number | null) => (serviceId ? { "service.id": serviceId } : {});
const HAS_PROVIDER = { $ne: [{ $ifNull: ["$providerId", null] }, null] };

/** Demand by hour of week (Monday = 1) and service: bookings by booked start, and how many got a provider. */
export const demandGridPipeline = (start: Date, end: Date, tz: string, serviceId: number | null) => [
	{ $match: { startDate: range(start, end), ...serviceMatch(serviceId) } },
	{ $limit: MAX_SCAN },
	{
		$group: {
			_id: {
				d: { $isoDayOfWeek: { date: "$startDate", timezone: tz } },
				h: { $hour: { date: "$startDate", timezone: tz } },
				s: "$service.id",
			},
			demand: { $sum: 1 },
			filled: { $sum: { $cond: [HAS_PROVIDER, 1, 0] } },
			hours: { $sum: "$hours" },
		},
	},
	{ $project: { _id: 0, day: "$_id.d", hour: "$_id.h", serviceId: "$_id.s", demand: 1, filled: 1, hours: 1 } },
];

/**
 * Supply by hour of week: distinct providers who went available (provider.availability_changed, available true),
 * for a service when given (their job types at the time). Recorded from the event-stream release on.
 */
export const supplyGridPipeline = (start: Date, end: Date, tz: string, serviceId: number | null) => [
	{
		$match: {
			type: "provider.availability_changed",
			at: range(start, end),
			"properties.available": true,
			...(serviceId ? { "properties.jobTypes": serviceId } : {}),
		},
	},
	{ $limit: MAX_SCAN },
	{
		$group: {
			_id: { d: { $isoDayOfWeek: { date: "$at", timezone: tz } }, h: { $hour: { date: "$at", timezone: tz } } },
			providers: { $addToSet: "$providerId" },
		},
	},
	{ $project: { _id: 0, day: "$_id.d", hour: "$_id.h", supply: { $size: "$providers" } } },
];

/** Grid precision in degrees (0.1 degree is about 11 km). */
export const AREA_PRECISION = 0.1;
export const MAX_AREA_CELLS = 500;

const snapped = (field: string) => ({ $round: [field, 1] });
const hasFix = (lat: string, lng: string) => ({
	[lat]: { $type: "number", $ne: 0 },
	[lng]: { $type: "number", $ne: 0 },
});

export const demandAreaPipeline = (start: Date, end: Date, serviceId: number | null) => [
	{ $match: { startDate: range(start, end), ...serviceMatch(serviceId), ...hasFix("latitude", "longitude") } },
	{ $limit: MAX_SCAN },
	{
		$group: {
			_id: { lat: snapped("$latitude"), lng: snapped("$longitude") },
			demand: { $sum: 1 },
			filled: { $sum: { $cond: [HAS_PROVIDER, 1, 0] } },
			value: { $sum: { $multiply: ["$rate", "$hours"] } },
		},
	},
	{ $sort: { demand: -1 } },
	{ $limit: MAX_AREA_CELLS },
	{ $project: { _id: 0, latitude: "$_id.lat", longitude: "$_id.lng", demand: 1, filled: 1, value: 1 } },
];

/** Approved providers by last known position (today's snapshot), for a service when given. */
export const supplyAreaPipeline = (serviceId: number | null) => [
	{
		$match: {
			"roles.Provider": true,
			providerStatus: "approved",
			...hasFix("currentLocation.latitude", "currentLocation.longitude"),
			...(serviceId ? { "selectedJobTypes.id": serviceId } : {}),
		},
	},
	{ $limit: MAX_SCAN },
	{
		$group: {
			_id: { lat: snapped("$currentLocation.latitude"), lng: snapped("$currentLocation.longitude") },
			providers: { $sum: 1 },
		},
	},
	{ $limit: MAX_AREA_CELLS },
	{ $project: { _id: 0, latitude: "$_id.lat", longitude: "$_id.lng", providers: 1 } },
];

// ---------------------------------------------------------------------------------------------------------------
// Leaderboards: top customers by paid value or count; top providers by earnings or completed jobs.

export const LEADERBOARD_LIMIT = 25;

const personJoin = (idField: string) => [
	{
		$lookup: {
			from: "users",
			localField: idField,
			foreignField: "_id",
			as: "_p",
			pipeline: [{ $project: { firstName: 1, lastName: 1, email: 1 } }],
		},
	},
	{ $set: { _p: { $first: "$_p" } } },
];

export const customerLeaderboardPipeline = (start: Date, end: Date, by: "value" | "count", limit: number) => [
	{ $match: paidWithin(start, end) },
	{ $limit: MAX_SCAN },
	...bookingOf({ userId: 1 }),
	{ $group: { _id: "$_b.userId", value: { $sum: "$amount" }, count: { $sum: 1 } } },
	{ $match: { _id: { $ne: null } } },
	{ $sort: by === "value" ? { value: -1, count: -1, _id: 1 } : { count: -1, value: -1, _id: 1 } },
	{ $limit: limit },
	...personJoin("_id"),
	{
		$project: {
			_id: 1,
			value: 1,
			count: 1,
			firstName: "$_p.firstName",
			lastName: "$_p.lastName",
			email: "$_p.email",
		},
	},
];

export const providerLeaderboardPipeline = (start: Date, end: Date, by: "value" | "count", limit: number) => [
	{ $match: { createdAt: range(start, end), status: { $ne: "cancelled" } } },
	{ $limit: MAX_SCAN },
	...bookingOf({ providerId: 1, hours: 1 }),
	{
		$group: {
			_id: "$_b.providerId",
			value: { $sum: "$amount" },
			count: { $sum: 1 },
			hours: { $sum: "$_b.hours" },
		},
	},
	{ $match: { _id: { $ne: null } } },
	{ $sort: by === "value" ? { value: -1, count: -1, _id: 1 } : { count: -1, value: -1, _id: 1 } },
	{ $limit: limit },
	...personJoin("_id"),
	{
		$project: {
			_id: 1,
			value: 1,
			count: 1,
			hours: 1,
			firstName: "$_p.firstName",
			lastName: "$_p.lastName",
			email: "$_p.email",
		},
	},
];

// ---------------------------------------------------------------------------------------------------------------
// Distributions: one value per subject (provider earnings, hours) or per booking, for a histogram.

export const DISTRIBUTIONS = {
	provider_earnings: { label: "Earnings per provider", unit: "money", collection: "earnings" },
	provider_hours: { label: "Hours worked per provider", unit: "hours", collection: "bookings" },
	provider_jobs: { label: "Jobs completed per provider", unit: "count", collection: "bookings" },
	customer_spend: { label: "Spend per customer", unit: "money", collection: "payments" },
	booking_value: { label: "Booking value", unit: "money", collection: "bookings" },
	booking_hours: { label: "Hours per booking", unit: "hours", collection: "bookings" },
	hourly_rate: { label: "Hourly rate", unit: "money", collection: "bookings" },
} as const;
export type DistributionId = keyof typeof DISTRIBUTIONS;

export const distributionPipeline = (id: DistributionId, start: Date, end: Date) => {
	const completed = { status: "completed", completedAt: range(start, end), providerId: { $ne: null } };
	switch (id) {
		case "provider_earnings":
			return [
				{ $match: { createdAt: range(start, end), status: { $ne: "cancelled" } } },
				{ $limit: MAX_SCAN },
				...bookingOf({ providerId: 1 }),
				{ $group: { _id: "$_b.providerId", v: { $sum: "$amount" } } },
				{ $project: { _id: 0, v: 1 } },
			];
		case "provider_hours":
			return [
				{ $match: completed },
				{ $limit: MAX_SCAN },
				{ $group: { _id: "$providerId", v: { $sum: "$hours" } } },
				{ $project: { _id: 0, v: 1 } },
			];
		case "provider_jobs":
			return [
				{ $match: completed },
				{ $limit: MAX_SCAN },
				{ $group: { _id: "$providerId", v: { $sum: 1 } } },
				{ $project: { _id: 0, v: 1 } },
			];
		case "customer_spend":
			return [
				{ $match: paidWithin(start, end) },
				{ $limit: MAX_SCAN },
				...bookingOf({ userId: 1 }),
				{ $group: { _id: "$_b.userId", v: { $sum: "$amount" } } },
				{ $project: { _id: 0, v: 1 } },
			];
		case "booking_value":
		case "booking_hours":
		case "hourly_rate":
			return [
				{ $match: { createdAt: range(start, end) } },
				{ $limit: MAX_SCAN },
				{
					$project: {
						_id: 0,
						v:
							id === "booking_value"
								? { $multiply: ["$rate", "$hours"] }
								: id === "booking_hours"
									? "$hours"
									: "$rate",
					},
				},
			];
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Repeat-booking rate input: per customer with a booking in the range, their first booking ever and the bookings in it.

export const repeatBookingPipeline = (start: Date, end: Date) => [
	{ $match: { createdAt: { $lt: end } } },
	{ $sort: { createdAt: -1 } },
	{ $limit: MAX_SCAN },
	{
		$group: {
			_id: "$userId",
			first: { $min: "$createdAt" },
			inRange: { $push: { $cond: [{ $gte: ["$createdAt", start] }, "$createdAt", "$$REMOVE"] } },
		},
	},
	{ $match: { "inRange.0": { $exists: true } } },
	{ $project: { _id: 0, first: 1, inRange: 1 } },
];

/** The earliest record, to start "all time": the first user or booking. */
export const EARLIEST_SOURCES = ["users", "bookings"] as const;
