// Run with: npx ts-node tests/operations.test.ts
// Pure logic behind the operations console: attention rules, periods and comparisons, the refund guard, coarse
// locations, display-status filters, search plans, list filters under hostile input, and suspension.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

// Never reach a database or a service from here.
delete process.env.DATABASE_URI;
mongoose.set("bufferCommands", false);
process.env.STRIPE_SECRET_KEY = "sk_test_unit_only";
process.env.ACCESS_TOKEN_SECRET = "test-access-secret";
process.env.REFRESH_TOKEN_SECRET = "test-refresh-secret";

/* eslint-disable @typescript-eslint/no-require-imports */
// Loaded first for its declaration of req.user, which auth.controller.ts relies on when compiled on its own.
require("../middleware/verifyJWT");
const ops = require("../lib/operations") as typeof import("../lib/operations");
const search = require("../lib/adminSearch") as typeof import("../lib/adminSearch");
const suspension = require("../lib/suspension") as typeof import("../lib/suspension");
const { parseListQuery, ListQueryError } = require("../lib/listQuery") as typeof import("../lib/listQuery");
const { USER_LIST_SPEC } = require("../controllers/admin/users.controller");
const { BOOKING_LIST_SPEC } = require("../controllers/admin/bookings.controller");
const { PAYMENT_LIST_SPEC, PAYOUT_LIST_SPEC, EARNING_LIST_SPEC } = require("../controllers/admin/payments.controller");
const { takeParams, booleanParam, enumParam } = require("../controllers/admin/operations.shared");
const { getBookingDisplayStatus } = require("../controllers/user-controllers/utils/booking.utils");
const { setEventWriter } = require("../lib/events");
const { setLogSink } = require("../lib/logger");
const UserModel = require("../dal/models/user.model").default;
/* eslint-enable @typescript-eslint/no-require-imports */

setLogSink(() => undefined);
setEventWriter(async () => undefined);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const oid = () => new mongoose.Types.ObjectId();

// --- Attention ---------------------------------------------------------------------------------------------------

test("attention: each rule includes what crossed its threshold and leaves the rest out", () => {
	const now = new Date("2026-11-19T12:00:00Z");
	const at = (offset: number) => new Date(now.getTime() + offset);
	const ids = Array.from({ length: 17 }, oid);
	const { items, counts } = ops.buildAttention(
		{
			unassignedPaid: [
				{ _id: ids[0], startDate: at(45 * MIN) }, // soon: high
				{ _id: ids[1], startDate: at(2 * HOUR) }, // within 3 h: medium
				{ _id: ids[2], startDate: at(5 * HOUR) }, // later: not listed
				{ _id: ids[3], startDate: at(-10 * MIN) }, // start passed: high
			],
			inProgress: [
				{ _id: ids[4], startDate: at(-4 * HOUR), hours: 2 }, // ended 2 h ago: medium
				{ _id: ids[5], startDate: at(-3 * HOUR), hours: 2.5 }, // ended 30 min ago: within grace
				{ _id: ids[6], startDate: at(-12 * HOUR), hours: 4 }, // 8 h late: high
			],
			acceptedNotStarted: [
				{ _id: ids[14], startDate: at(-90 * MIN), hours: 4 }, // late, shift still running: medium
				{ _id: ids[15], startDate: at(-5 * HOUR), hours: 2 }, // shift ended 3 h ago: high
				{ _id: ids[16], startDate: at(-30 * MIN), hours: 2 }, // under an hour late: not listed
			],
			startRequests: [
				{ _id: ids[7], startDate: at(-HOUR), startRequestedAt: at(-20 * MIN) },
				{ _id: ids[8], startDate: at(0), startRequestedAt: at(-5 * MIN) }, // too recent
			],
			pendingEarnings: [
				{ _id: ids[9], createdAt: at(-3 * HOUR), amount: 95 },
				{ _id: ids[10], createdAt: at(-5 * MIN), amount: 50 },
			],
			failedPayouts: [
				{ _id: ids[11], amount: 120, status: "failed", failedAt: at(-DAY) },
				{ _id: oid(), amount: 10, status: "failed", failedAt: at(-40 * DAY) }, // too old
			],
			failedRefunds: [{ _id: ids[12], refundAmount: 80, refundStatus: "failed", updatedAt: at(-HOUR) }],
			pendingApplications: [
				{ _id: ids[13], createdAt: at(-3 * DAY) },
				{ _id: oid(), createdAt: at(-1 * DAY) }, // under two days
			],
		},
		now,
	);
	const listed = items.map((item) => item.link.id);
	for (const i of [0, 1, 3, 4, 6, 7, 9, 11, 12, 13, 14, 15])
		assert.ok(listed.includes(String(ids[i])), `item ${i} listed`);
	for (const i of [2, 5, 8, 10, 16]) assert.equal(listed.includes(String(ids[i])), false, `item ${i} not listed`);
	assert.deepEqual(counts, {
		unassigned_near_start: 3,
		overdue_in_progress: 2,
		accepted_not_started: 2,
		start_request_waiting: 1,
		earning_not_released: 1,
		payout_failed: 1,
		refund_failed: 1,
		application_waiting: 1,
	});
	const byId = new Map(items.map((item) => [item.link.id, item]));
	assert.equal(byId.get(String(ids[0]))!.severity, "high");
	assert.match(byId.get(String(ids[0]))!.explanation, /starts in 45 min/);
	assert.equal(byId.get(String(ids[1]))!.severity, "medium");
	assert.match(byId.get(String(ids[3]))!.explanation, /passed 10 min ago/);
	assert.match(byId.get(String(ids[4]))!.explanation, /2 h past its scheduled end/);
	assert.equal(byId.get(String(ids[6]))!.severity, "high");
	assert.equal(byId.get(String(ids[14]))!.kind, "accepted_not_started");
	assert.equal(byId.get(String(ids[14]))!.severity, "medium");
	assert.match(byId.get(String(ids[14]))!.explanation, /not started 1 h 30 min after its start time/);
	assert.equal(byId.get(String(ids[15]))!.severity, "high");
	assert.match(byId.get(String(ids[15]))!.explanation, /never started; the shift ended 3 h ago/);
	assert.equal(byId.get(String(ids[15]))!.link.type, "booking");
	assert.equal(byId.get(String(ids[9]))!.link.type, "earning");
	assert.equal(byId.get(String(ids[11]))!.link.type, "payout");
	assert.equal(byId.get(String(ids[12]))!.link.type, "payment");
	assert.equal(byId.get(String(ids[13]))!.link.type, "application");
	// Severity first, then oldest first.
	const order = items.map((item) => item.severity);
	assert.deepEqual(
		order,
		[...order].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)),
	);
	assert.equal(items[items.length - 1].kind, "application_waiting");
});

test("attention: at most perKind items of one kind, with the true count", () => {
	const now = new Date("2026-11-19T12:00:00Z");
	const many = Array.from({ length: 30 }, (_, i) => ({
		_id: oid(),
		createdAt: new Date(now.getTime() - (3 + i) * DAY),
	}));
	const { items, counts } = ops.buildAttention(
		{
			unassignedPaid: [],
			inProgress: [],
			acceptedNotStarted: [],
			startRequests: [],
			pendingEarnings: [],
			failedPayouts: [],
			failedRefunds: [],
			pendingApplications: many,
		},
		now,
	);
	assert.equal(items.length, ops.ATTENTION_THRESHOLDS.perKind);
	assert.equal(counts.application_waiting, 30);
	assert.equal(items[0].link.id, String(many[29]._id), "oldest first within a severity");
});

test("durations read naturally", () => {
	assert.equal(ops.formatDuration(45 * MIN), "45 min");
	assert.equal(ops.formatDuration(3 * HOUR + 20 * MIN), "3 h 20 min");
	assert.equal(ops.formatDuration(2 * HOUR), "2 h");
	assert.equal(ops.formatDuration(3 * DAY + 4 * HOUR), "3 days 4 h");
	assert.equal(ops.formatDuration(-10 * MIN), "10 min");
});

// --- Periods -------------------------------------------------------------------------------------------------

test("periods in UTC: today vs yesterday to the same time, this week (from Monday) vs last week to the same point", () => {
	const now = new Date("2026-11-19T15:30:00Z"); // a Thursday
	const p = ops.periodBounds(now);
	assert.equal(p.today.from.toISOString(), "2026-11-19T00:00:00.000Z");
	assert.equal(p.today.to.toISOString(), now.toISOString());
	assert.equal(p.yesterday.from.toISOString(), "2026-11-18T00:00:00.000Z");
	assert.equal(p.yesterday.to.toISOString(), "2026-11-18T15:30:00.000Z");
	assert.equal(p.thisWeek.from.toISOString(), "2026-11-16T00:00:00.000Z");
	assert.equal(p.lastWeek.from.toISOString(), "2026-11-09T00:00:00.000Z");
	assert.equal(p.lastWeek.to.toISOString(), "2026-11-12T15:30:00.000Z");
});

test("periods in a time zone, including a week that starts on the previous UTC day and a DST change", () => {
	// 00:30 in Karachi (UTC+5) on Monday 16 Nov is still Sunday in UTC.
	const karachi = ops.periodBounds(new Date("2026-11-15T19:30:00Z"), "Asia/Karachi");
	assert.equal(karachi.today.from.toISOString(), "2026-11-15T19:00:00.000Z");
	assert.equal(karachi.thisWeek.from.toISOString(), "2026-11-15T19:00:00.000Z", "Monday 00:00 local");
	// New York on Monday 2 November 2026, the day after clocks went back (EDT -4 -> EST -5).
	const ny = ops.periodBounds(new Date("2026-11-02T17:00:00Z"), "America/New_York");
	assert.equal(ny.today.from.toISOString(), "2026-11-02T05:00:00.000Z");
	assert.equal(ny.yesterday.from.toISOString(), "2026-11-01T04:00:00.000Z", "Sunday began in EDT");
	assert.equal(ny.lastWeek.from.toISOString(), "2026-10-26T04:00:00.000Z");
	assert.equal(ops.parseTimeZone(undefined), "UTC");
	assert.equal(ops.parseTimeZone("Europe/London"), "Europe/London");
	for (const bad of ["Mars/Base", "../etc", { $ne: 1 }, ["UTC"], "x".repeat(100)]) {
		assert.throws(() => ops.parseTimeZone(bad), ops.TimeZoneError, JSON.stringify(bad));
	}
});

test("comparisons: change and percentage, money rounded to cents, no percentage from zero", () => {
	assert.deepEqual(ops.compareValues(12, 8), { current: 12, previous: 8, change: 4, changePct: 50 });
	assert.deepEqual(ops.compareValues(3, 0), { current: 3, previous: 0, change: 3, changePct: null });
	assert.deepEqual(ops.compareValues(0.1 + 0.2, 0.1, true), {
		current: 0.3,
		previous: 0.1,
		change: 0.2,
		changePct: 200,
	});
	assert.deepEqual(ops.compareValues(5, 10), { current: 5, previous: 10, change: -5, changePct: -50 });
	assert.equal(ops.platformFeeOf(80), 4);
	assert.equal(ops.platformFeeFromEarning(76), 4);
	assert.equal(ops.platformFeeFromEarning(0), 0);
});

// --- Refund guard ----------------------------------------------------------------------------------------------

const paid = (extra: Record<string, unknown> = {}) => ({
	amount: 80,
	status: "completed",
	paymentIntentId: "pi_3Nabcdef",
	...extra,
});

test("refund guard: whole remainder by default, partial amounts, never more than is left", () => {
	assert.deepEqual(ops.planRefund(paid()), { ok: true, cents: 8000, partial: false, remainingAfterCents: 0 });
	assert.deepEqual(ops.planRefund(paid(), 30), { ok: true, cents: 3000, partial: true, remainingAfterCents: 5000 });
	assert.deepEqual(ops.planRefund(paid(), 80.01), { ok: false, code: "too_much", remainingCents: 8000 });
	for (const bad of [0, -5, 10.005, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal((ops.planRefund(paid(), bad) as any).code, "invalid_amount", String(bad));
	}
	assert.equal((ops.planRefund(paid({ status: "pending" })) as any).code, "not_paid");
	assert.equal((ops.planRefund(paid({ paymentIntentId: null })) as any).code, "not_paid");
});

test("refund guard: earlier refunds count (admin entries, and a cancellation refund in the top-level fields)", () => {
	const withEntries = paid({
		refundId: "re_2",
		refundStatus: "pending",
		refundAmount: 50,
		refunds: [
			{ idempotencyKey: "k1", amount: 30, status: "succeeded", refundId: "re_1" },
			{ idempotencyKey: "k2", amount: 20, status: "pending", refundId: "re_2" },
			{ idempotencyKey: "k3", amount: 15, status: "failed", refundId: null },
			{ idempotencyKey: "k4", amount: 5, status: "requested", refundId: null },
		],
	});
	assert.deepEqual(ops.refundTotals(withEntries), {
		paidCents: 8000,
		committedCents: 5500,
		succeededCents: 3000,
		remainingCents: 2500,
	});
	assert.deepEqual(ops.planRefund(withEntries, 25), { ok: true, cents: 2500, partial: true, remainingAfterCents: 0 });
	assert.equal((ops.planRefund(withEntries, 25.01) as any).code, "too_much");

	const cancelled = paid({ refundId: "re_full", refundStatus: "succeeded", refundAmount: 80 });
	assert.equal((ops.planRefund(cancelled) as any).code, "nothing_left");
	const failed = paid({ refundId: "re_full", refundStatus: "failed", refundAmount: 80 });
	assert.deepEqual(ops.refundTotals(failed).remainingCents, 8000, "a failed refund gives the amount back");
	// Payments from before refundStatus lost its default carry "pending" with no refund id: no refund.
	assert.equal(ops.refundTotals(paid({ refundStatus: "pending" })).committedCents, 0);
});

test("refund guard: two plans read from the same state cannot both pass once the first is reserved", () => {
	const state: any = paid({ refunds: [] });
	const first = ops.planRefund(state, 60);
	assert.equal(first.ok, true);
	state.refunds.push({ idempotencyKey: "a", amount: 60, status: "requested" });
	assert.equal((ops.planRefund(state, 60) as any).code, "too_much");
	assert.equal(ops.planRefund(state, 20).ok, true);
});

// --- Coarse locations -------------------------------------------------------------------------------------------

test("coarse locations: fixed 0.01 degree grid, nothing for missing, invalid or 0,0 positions", () => {
	assert.deepEqual(ops.coarseLocation(51.507351, -0.127758), { latitude: 51.51, longitude: -0.13, precisionKm: 1.1 });
	assert.deepEqual(ops.coarseLocation(40.712776, -74.005974), {
		latitude: 40.71,
		longitude: -74.01,
		precisionKm: 1.1,
	});
	const a = ops.coarseLocation(51.50401, -0.12401)!;
	const b = ops.coarseLocation(51.50449, -0.12449)!;
	assert.deepEqual([a.latitude, a.longitude], [b.latitude, b.longitude], "nearby points share a cell");
	for (const [lat, lng] of [
		[null, null],
		[0, 0],
		[91, 0],
		[0, 181],
		["51.5", "-0.1"],
		[Number.NaN, 1],
	]) {
		assert.equal(ops.coarseLocation(lat, lng), null, `${lat},${lng}`);
	}
	const rounded = ops.coarseLocation(51.123456789, 0.987654321)!;
	assert.ok(String(rounded.latitude).split(".")[1].length <= 2);
});

// --- Display status filters ----------------------------------------------------------------------------------

test("display-status filters select exactly what getBookingDisplayStatus reports", () => {
	const now = new Date("2026-11-19T12:00:00Z");
	const future = new Date(now.getTime() + DAY);
	const past = new Date(now.getTime() - DAY);
	const provider = oid();
	const samples = [
		{ status: "pending", providerId: null, startDate: future, userApprovalRequested: false },
		{ status: "pending", providerId: provider, startDate: future, userApprovalRequested: false },
		{ status: "pending", providerId: provider, startDate: past, userApprovalRequested: true },
		{ status: "in progress", providerId: provider, startDate: past },
		{ status: "completed", providerId: provider, startDate: past },
		{ status: "cancelled", providerId: provider, startDate: future, cancelledAt: now },
		{
			status: "cancelled",
			providerId: null,
			startDate: past,
			cancelledAt: now,
			cancellationReason: ops.EXPIRED_REASON,
		},
		{ status: "cancelled", providerId: null, startDate: past, cancelledAt: now },
		{ status: "pending", providerId: null, startDate: past, userApprovalRequested: false },
	];
	// A tiny evaluator for the operators these filters use, so the filter and the function are compared directly.
	const get = (doc: any, path: string) => doc[path.replace(/^\$/, "")];
	const matches = (doc: any, filter: any): boolean =>
		Object.entries(filter).every(([key, cond]: [string, any]) => {
			if (key === "$or") return cond.some((f: any) => matches(doc, f));
			if (key === "$nor") return !cond.some((f: any) => matches(doc, f));
			if (key === "$expr") {
				const [left, right] = cond.$gte;
				return new Date(get(doc, left)).getTime() >= new Date(get(doc, right)).getTime();
			}
			const value = doc[key] ?? null;
			if (
				cond &&
				typeof cond === "object" &&
				!(cond instanceof Date) &&
				!(cond instanceof mongoose.Types.ObjectId)
			) {
				if ("$ne" in cond) return String(value) !== String(cond.$ne) && !(cond.$ne === null && value === null);
				if ("$in" in cond) return cond.$in.some((v: any) => (v ?? null) === (value ?? null));
				if ("$gte" in cond) return value >= cond.$gte;
				if ("$lt" in cond) return value < cond.$lt;
			}
			return cond === null ? value === null : String(value) === String(cond);
		});
	const realNow = Date.now;
	Date.now = () => now.getTime();
	try {
		for (const status of ops.DISPLAY_STATUSES) {
			const filter = ops.displayStatusFilter(status, now)!;
			for (const sample of samples) {
				assert.equal(
					matches(sample, filter),
					getBookingDisplayStatus(sample) === status,
					`${status} vs ${JSON.stringify(sample)}`,
				);
			}
		}
	} finally {
		Date.now = realNow;
	}
	assert.equal(ops.displayStatusFilter("anything", now), null);
	assert.equal(ops.bookingReference("64b7f0c2a1b2c3d4e5f60718"), "HH-E5F60718");
});

// --- Search plans ------------------------------------------------------------------------------------------------

test("search plans: ids, references, Stripe ids, emails, phones and names", () => {
	assert.deepEqual(search.buildSearchPlan(" 64B7F0C2A1B2C3D4E5F60718 "), {
		text: "64B7F0C2A1B2C3D4E5F60718",
		objectId: "64b7f0c2a1b2c3d4e5f60718",
	});
	assert.equal(search.buildSearchPlan("hh-e5f60718").reference, "HH-E5F60718");
	assert.equal(search.buildSearchPlan("E5F60718").reference, "HH-E5F60718");
	assert.deepEqual(search.buildSearchPlan("pi_3NabcdefGHIJ").stripeId, {
		kind: "payment_intent",
		id: "pi_3NabcdefGHIJ",
	});
	assert.deepEqual(search.buildSearchPlan("re_1Nabcdef").stripeId, { kind: "refund", id: "re_1Nabcdef" });
	assert.equal(search.buildSearchPlan("Jane.Doe@Example").email, "jane.doe@example");
	assert.equal(search.buildSearchPlan("+44 7700 900").phone, "+44 7700 900");
	assert.deepEqual(search.buildSearchPlan("jane").names, ["jane"]);
	assert.deepEqual(search.buildSearchPlan("Jane  Mary   Doe").names, ["Jane", "Doe"]);
	assert.deepEqual(search.buildSearchPlan("Zoë O'Neil").names, ["Zoë", "O'Neil"]);
	assert.equal(search.buildSearchPlan("j").names, undefined, "one letter is too broad");
	assert.equal(search.isSearchable(search.buildSearchPlan("!!")), false);
});

test("search plans refuse hostile input and never build a pattern from it", () => {
	for (const bad of [undefined, ["a", "b"], { $regex: ".*" }, 5, "", "   ", "x".repeat(101), "a\u0000b", "ab￿"]) {
		assert.throws(() => search.buildSearchPlan(bad), search.SearchQueryError, JSON.stringify(bad));
	}
	const plan = search.buildSearchPlan("(a+)+$ .*");
	assert.equal(search.isSearchable(plan), false, "regex syntax is not a name, email or id");
	const queries = [
		...search.userSearchQueries(search.buildSearchPlan("jane.doe@ex")),
		...search.userSearchQueries(search.buildSearchPlan("Jane Doe")),
		...search.userSearchQueries(search.buildSearchPlan("+1 (555) 01")),
		...search.applicationSearchQueries(search.buildSearchPlan("doe")),
		...search.bookingSearchQueries(search.buildSearchPlan("12 high st"), { addressPrefix: true }),
	];
	for (const query of queries) {
		const text = JSON.stringify(query.filter);
		// The only regular expression is the anchored, escaped phone prefix (case-sensitive, on an index).
		if (text.includes("$regex")) {
			const pattern = (query.filter as any).phone.$regex as string;
			assert.ok(pattern.startsWith("^"), "anchored");
			assert.equal(query.collation, false);
			assert.equal(new RegExp(pattern).test("+1 (555) 0100"), true);
			assert.equal(new RegExp(pattern).test("x+1 (555) 0100"), false);
			assert.equal(
				"$options" in (query.filter as any).phone,
				false,
				"case-sensitive, so the index range is tight",
			);
		} else {
			assert.equal(text.includes("$where"), false);
		}
	}
	assert.deepEqual(search.prefixRange("jan"), { $gte: "jan", $lt: "jan￿" });
	const names = search.userSearchQueries(search.buildSearchPlan("Jane Doe"));
	assert.deepEqual(names, [
		{ filter: { firstName: search.prefixRange("Jane"), lastName: search.prefixRange("Doe") }, collation: true },
	]);
	const byStripe = search.paymentSearchQueries(search.buildSearchPlan("re_1Nabcdef"));
	assert.deepEqual(
		byStripe.map((q) => q.filter),
		[{ refundId: "re_1Nabcdef" }, { "refunds.refundId": "re_1Nabcdef" }],
	);
});

// --- List filters under hostile input -------------------------------------------------------------------------

const listFails = (spec: any, query: Record<string, unknown>, field: string) =>
	assert.throws(
		() => parseListQuery(query, spec),
		(error: unknown) => error instanceof ListQueryError && (error as any).field === field,
		JSON.stringify(query),
	);

test("list filters: operators, arrays, unknown names, bad enums, dates and amounts are refused with the field", () => {
	listFails(USER_LIST_SPEC, { role: { $ne: "customer" } }, "role");
	listFails(USER_LIST_SPEC, { role: ["customer", "provider"] }, "role");
	listFails(USER_LIST_SPEC, { role: "admin" }, "role");
	listFails(USER_LIST_SPEC, { password: "x" }, "password");
	listFails(USER_LIST_SPEC, { suspended: "yes" }, "suspended");
	listFails(USER_LIST_SPEC, { activeFrom: "last week" }, "activeFrom");
	listFails(USER_LIST_SPEC, { sort: "password" }, "sort");
	listFails(BOOKING_LIST_SPEC, { displayStatus: "lost" }, "displayStatus");
	listFails(BOOKING_LIST_SPEC, { amountMin: "1e9" }, "amountMin");
	listFails(BOOKING_LIST_SPEC, { amountMax: "-1" }, "amountMax");
	listFails(BOOKING_LIST_SPEC, { service: "4" }, "service");
	listFails(BOOKING_LIST_SPEC, { providerId: "not-an-id" }, "providerId");
	listFails(BOOKING_LIST_SPEC, { startFrom: "2026-13-45" }, "startFrom");
	listFails(PAYMENT_LIST_SPEC, { refundState: "partial" }, "refundState");
	listFails(PAYMENT_LIST_SPEC, { status: "completed", "status[$ne]": "x" }, "status[$ne]");
	listFails(PAYOUT_LIST_SPEC, { status: "lost" }, "status");
	listFails(EARNING_LIST_SPEC, { amountMin: "abc" }, "amountMin");

	const users = parseListQuery(
		{ role: "provider", suspended: "false", activeFrom: "2026-11-01", sort: "-lastActiveAt" },
		USER_LIST_SPEC,
	);
	assert.deepEqual(users.filter, {
		$and: [
			{ "roles.Provider": true },
			{ suspended: { $ne: true } },
			{ lastActiveAt: { $gte: new Date("2026-11-01T00:00:00.000Z") } },
		],
	});
	assert.deepEqual(users.sort, { lastActiveAt: -1, _id: -1 });
	const bookings = parseListQuery({ amountMin: "50", hasProvider: "false", service: "2" }, BOOKING_LIST_SPEC);
	assert.deepEqual(bookings.filter, {
		$and: [
			{ $expr: { $gte: [{ $multiply: ["$rate", "$hours"] }, 50] } },
			{ providerId: null },
			{ "service.id": 2 },
		],
	});
});

test("parameters taken outside the list helper: single strings only, booleans and enums checked", () => {
	assert.throws(() => takeParams({ q: ["a", "b"] }, ["q"]), ListQueryError);
	assert.throws(() => takeParams({ q: { $gt: "" } }, ["q"]), ListQueryError);
	const { rest, values } = takeParams({ q: "jane", page: "2", hasBookings: "" }, ["q", "hasBookings"]);
	assert.deepEqual(values, { q: "jane" });
	assert.deepEqual(rest, { page: "2" });
	assert.equal(booleanParam("true", "x"), true);
	assert.throws(() => booleanParam("1", "x"), ListQueryError);
	assert.equal(enumParam("paid", "paymentState", ["paid", "unpaid"]), "paid");
	assert.throws(() => enumParam("free", "paymentState", ["paid", "unpaid"]), ListQueryError);
});

// --- Suspension ----------------------------------------------------------------------------------------------

test("suspension: one update sets the flag, ends every session and turns availability off; reinstating clears it", () => {
	const adminId = oid();
	const now = new Date("2026-11-19T12:00:00Z");
	assert.deepEqual(suspension.suspendUpdate(adminId, "Chargeback fraud", now), {
		$set: {
			suspended: true,
			suspendedAt: now,
			suspendedBy: adminId,
			suspendedReason: "Chargeback fraud",
			isProviderAvailable: false,
			sessions: [],
			refreshToken: [],
			sessionId: "",
		},
	});
	assert.deepEqual(suspension.reinstateUpdate(), {
		$set: { suspended: false },
		$unset: { suspendedAt: 1, suspendedBy: 1, suspendedReason: 1 },
	});
	assert.equal(suspension.isSuspended({ suspended: true }), true);
	assert.equal(suspension.isSuspended({}), false);
	assert.equal(suspension.isSuspended(null), false);
	// Not 401/403: both apps give those a different meaning at sign-in.
	assert.equal(suspension.SUSPENDED_SIGN_IN.status, 423);
	assert.equal(suspension.SUSPENDED_SIGN_IN.body.code, "account_suspended");
});

test("suspension: the person never sees who suspended them or why", () => {
	const user = new UserModel({
		firstName: "Jane",
		lastName: "Doe",
		email: "jane@example.com",
		password: "x".repeat(10),
		roles: { User: true, Provider: false },
		suspended: true,
		suspendedReason: "fraud",
		suspendedBy: oid(),
	});
	const json = user.toJSON() as Record<string, unknown>;
	assert.equal(json.suspended, true);
	assert.equal("suspendedReason" in json, false);
	assert.equal("suspendedBy" in json, false);
	assert.equal(new UserModel({ email: "a@b.co" }).suspended, false, "defaults to not suspended");
});

const stubFindOne = (user: unknown) => {
	const original = UserModel.findOne;
	UserModel.findOne = (() => ({ exec: async () => user, then: (r: any) => Promise.resolve(user).then(r) })) as any;
	return () => (UserModel.findOne = original);
};

const fakeUser = (extra: Record<string, unknown> = {}) =>
	new UserModel({
		firstName: "Pat",
		lastName: "Lee",
		email: "pat@example.com",
		password: bcrypt.hashSync("Correct-horse-1", 4),
		isEmailVerified: true,
		roles: { User: false, Provider: true },
		providerStatus: "approved",
		sessions: [{ sessionId: "s1", refreshTokens: [], lastUsedAt: new Date() }],
		...extra,
	});

test("suspension: the API and the provider socket refuse a suspended user even with a live session", async () => {
	/* eslint-disable-next-line @typescript-eslint/no-require-imports */
	const { verifyAccessToken } = require("../controllers/user-controllers/utils/token.utils");
	const token = jwt.sign({ UserInfo: { email: "pat@example.com", sessionId: "s1" } }, "test-access-secret");
	let restore = stubFindOne(fakeUser());
	try {
		assert.equal((await verifyAccessToken(token)).ok, true, "control: an active session works");
	} finally {
		restore();
	}
	restore = stubFindOne(fakeUser({ suspended: true }));
	try {
		assert.deepEqual(await verifyAccessToken(token), { ok: false, reason: "inactive" });
	} finally {
		restore();
	}
});

test("suspension: refresh is refused (403, which both apps treat as signed out)", async () => {
	/* eslint-disable-next-line @typescript-eslint/no-require-imports */
	const { refreshSession } = require("../controllers/user-controllers/utils/session.utils");
	const token = jwt.sign({ UserInfo: { email: "pat@example.com", sessionId: "s1" } }, "test-refresh-secret");
	const restore = stubFindOne(fakeUser({ suspended: true }));
	try {
		const result = await refreshSession(token);
		assert.equal(result.ok, false);
		assert.equal(result.status, 403);
	} finally {
		restore();
	}
});

test("suspension: sign-in with the right password answers 423 account_suspended; a wrong password still 401", async () => {
	/* eslint-disable-next-line @typescript-eslint/no-require-imports */
	const { handleLogin } = require("../controllers/user-controllers/auth.controller");
	const call = async (password: string) => {
		const res: any = { statusCode: 200 };
		res.status = (code: number) => ((res.statusCode = code), res);
		res.json = (body: unknown) => ((res.body = body), res);
		await handleLogin({ body: { email: "pat@example.com", password }, headers: {} } as any, res);
		return res;
	};
	const restore = stubFindOne(fakeUser({ suspended: true }));
	try {
		const right = await call("Correct-horse-1");
		assert.equal(right.statusCode, 423);
		assert.equal(right.body.code, "account_suspended");
		const wrong = await call("Wrong-horse-1");
		assert.equal(wrong.statusCode, 401, "nothing about the suspension without the password");
	} finally {
		restore();
	}
});
