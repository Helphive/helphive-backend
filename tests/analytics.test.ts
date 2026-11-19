// Pure logic behind the analytics API: periods and time zones, bucket filling, percentiles, histograms, deltas,
// cohorts, funnels, query validation under hostile input, saved-view validation, the cache, series assembly and the
// pipeline builders' shapes. No database, no network, no timers.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

delete process.env.DATABASE_URI;
mongoose.set("bufferCommands", false);
process.env.STRIPE_SECRET_KEY = "sk_test_unit_only";

/* eslint-disable @typescript-eslint/no-require-imports */
const periods = require("../lib/analytics/periods") as typeof import("../lib/analytics/periods");
const stats = require("../lib/analytics/stats") as typeof import("../lib/analytics/stats");
const query = require("../lib/analytics/query") as typeof import("../lib/analytics/query");
const metrics = require("../lib/analytics/metrics") as typeof import("../lib/analytics/metrics");
const compute = require("../lib/analytics/compute") as typeof import("../lib/analytics/compute");
const reports = require("../lib/analytics/reports") as typeof import("../lib/analytics/reports");
const views = require("../lib/analytics/views") as typeof import("../lib/analytics/views");
const { TtlCache } = require("../lib/analytics/cache") as typeof import("../lib/analytics/cache");
/* eslint-enable @typescript-eslint/no-require-imports */

const day = (s: string) => periods.parseDay(s)!;
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------------------------
// Periods and time zones

test("parseDay accepts real dates only", () => {
	assert.deepEqual(periods.parseDay("2026-02-28"), { year: 2026, month: 2, day: 28 });
	for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-01", "2026-01-01T00:00", "", "x"]) {
		assert.equal(periods.parseDay(bad), null, bad);
	}
});

test("day buckets start at the operator's midnight, across a daylight-saving change", () => {
	// London moves to BST on 2026-03-29.
	const r = periods.resolveRange(day("2026-03-28"), day("2026-03-30"), "Europe/London", "day");
	assert.deepEqual(
		r.buckets.map((b) => iso(b.start)),
		["2026-03-28T00:00:00.000Z", "2026-03-29T00:00:00.000Z", "2026-03-29T23:00:00.000Z"],
	);
	assert.equal(iso(r.end.getTime()), "2026-03-30T23:00:00.000Z");
	assert.equal(r.days, 3);
});

test("week buckets start on Monday (the first may begin before the range) and month buckets on the 1st", () => {
	const w = periods.resolveRange(day("2026-11-19"), day("2026-11-30"), "UTC", "week");
	assert.deepEqual(
		w.buckets.map((b) => b.key),
		["2026-11-16", "2026-11-23", "2026-11-30"],
	);
	const m = periods.resolveRange(day("2026-01-31"), day("2026-03-01"), "Asia/Kolkata", "month");
	assert.deepEqual(
		m.buckets.map((b) => b.key),
		["2026-01-01", "2026-02-01", "2026-03-01"],
	);
	assert.equal(iso(m.buckets[1].start), "2026-01-31T18:30:00.000Z");
});

test("previousRange is the same number of days immediately before", () => {
	const r = periods.resolveRange(day("2026-11-01"), day("2026-11-30"), "UTC", "day");
	const p = periods.previousRange(r);
	assert.equal(periods.formatDay(p.fromDay), "2026-10-02");
	assert.equal(periods.formatDay(p.toDay), "2026-10-31");
	assert.equal(p.buckets.length, 30);
	assert.equal(p.end.getTime(), r.start.getTime());
});

test("ranges are bounded: reversed, too long and too many buckets are refused", () => {
	assert.throws(() => periods.resolveRange(day("2026-02-01"), day("2026-01-01"), "UTC", "day"), periods.PeriodError);
	assert.throws(() => periods.resolveRange(day("2020-01-01"), day("2026-01-01"), "UTC", "month"), /at most/);
	assert.throws(
		() => periods.resolveRange(day("2024-01-01"), day("2026-01-01"), "UTC", "day"),
		(e: any) => e.field === "interval",
	);
});

test("fillBuckets gives every empty day its empty value and places rows by local time", () => {
	const r = periods.resolveRange(day("2026-11-01"), day("2026-11-05"), "America/New_York", "day");
	const filled = periods.fillBuckets(
		r,
		[
			{ t: new Date("2026-11-02T05:00:00Z"), value: 3 }, // midnight on the 2nd in New York (EST)
			{ t: new Date("2026-11-02T04:59:59Z"), value: 1 }, // still the 1st there
			{ t: new Date("2026-12-01T00:00:00Z"), value: 9 }, // outside
		],
		0,
		(a, b) => a + b,
	);
	assert.deepEqual(filled, [1, 3, 0, 0, 0]);
});

test("rangeDays resolves presets in the time zone and cuts a future 'to' to today", () => {
	const now = new Date("2026-11-19T23:30:00Z"); // already the 20th in Tokyo
	assert.deepEqual(query.rangeDays({ preset: "7d" }, now, "Asia/Tokyo"), {
		fromDay: day("2026-11-14"),
		toDay: day("2026-11-20"),
	});
	assert.deepEqual(query.rangeDays({ preset: "ytd" }, now, "UTC").fromDay, day("2026-01-01"));
	assert.deepEqual(query.rangeDays({ preset: "all" }, now, "UTC", day("2025-03-04")).fromDay, day("2025-03-04"));
	assert.deepEqual(query.rangeDays({ preset: "all" }, now, "UTC", null).fromDay, day("2026-11-19"));
	assert.deepEqual(
		query.rangeDays({ preset: "custom", from: day("2026-11-01"), to: day("2027-01-01") }, now, "UTC").toDay,
		day("2026-11-19"),
	);
	assert.equal(query.autoInterval(30), "day");
	assert.equal(query.autoInterval(200), "week");
	assert.equal(query.autoInterval(700), "month");
});

// ---------------------------------------------------------------------------------------------------------------
// Statistics

test("percentile interpolates between ranks; distribution ignores non-numbers", () => {
	assert.equal(stats.percentile([], 50), null);
	assert.equal(stats.percentile([7], 90), 7);
	assert.equal(stats.percentile([1, 2, 3, 4], 50), 2.5);
	assert.equal(stats.percentile([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90), 90);
	const d = stats.distribution([5, null, "x", 1, 3, NaN, Infinity]);
	assert.deepEqual(d, { count: 3, mean: 3, p50: 3, p90: 4.6, min: 1, max: 5 });
});

test("histogram uses round bins that cover every value", () => {
	const bins = stats.histogram([3, 7, 12, 48, 50], 5);
	assert.equal(bins[0].from, 0);
	assert.equal(bins[0].to - bins[0].from, 10);
	assert.equal(
		bins.reduce((n, b) => n + b.count, 0),
		5,
	);
	assert.deepEqual(stats.histogram([], 5), []);
	assert.deepEqual(stats.histogram([4, 4], 5), [{ from: 4, to: 5, count: 2 }]);
});

test("delta: change and percentage, null when there is no base", () => {
	assert.deepEqual(stats.delta(12, 8), { current: 12, previous: 8, change: 4, changePct: 50 });
	assert.deepEqual(stats.delta(3, 0), { current: 3, previous: 0, change: 3, changePct: null });
	assert.deepEqual(stats.delta(null, 4), { current: null, previous: 4, change: null, changePct: null });
	assert.equal(stats.delta(-5, -10).changePct, 50);
});

test("cohorts: the first month decides, history before the window still counts, later months are offsets", () => {
	const rows = stats.cohortMatrix(
		[
			{ id: "a", month: "2026-09" },
			{ id: "a", month: "2026-11" },
			{ id: "b", month: "2026-09" },
			{ id: "b", month: "2026-10" },
			{ id: "b", month: "2026-10" },
			{ id: "c", month: "2026-07" }, // cohort before the window: not listed
			{ id: "c", month: "2026-10" },
			{ id: "d", month: "2026-11" },
		],
		["2026-09", "2026-10", "2026-11"],
		"2026-11",
	);
	assert.deepEqual(
		rows.map((r) => [r.cohort, r.size, r.cells.map((c) => c.count)]),
		[
			["2026-09", 2, [2, 1, 1]],
			["2026-10", 0, [0, 0]],
			["2026-11", 1, [1]],
		],
	);
	assert.equal(rows[0].cells[1].rate, 50);
	assert.equal(rows[1].cells[0].rate, null);
});

test("funnel is strict and ordered: a later step without an earlier one does not count", () => {
	const steps = [
		{ id: "a", label: "A" },
		{ id: "b", label: "B" },
		{ id: "c", label: "C" },
	];
	const out = stats.funnel(steps, [
		{ reached: [true, true, true], count: 2 },
		{ reached: [true, false, true], count: 5 }, // skipped B: stops at A
		{ reached: [true, true, false], count: 3 },
	]);
	assert.deepEqual(
		out.map((s) => [s.id, s.count, s.fromStart, s.fromPrevious]),
		[
			["a", 10, 100, null],
			["b", 5, 50, 50],
			["c", 2, 20, 40],
		],
	);
	assert.deepEqual(
		stats.funnel(steps, []).map((s) => s.fromStart),
		[null, null, null],
	);
});

// ---------------------------------------------------------------------------------------------------------------
// Query validation

test("series queries accept the whitelist and answer defaults", () => {
	const q = query.parseSeriesQuery({ metric: "bookings_created", breakdown: "service", tz: "Europe/London" });
	assert.equal(q.metric.id, "bookings_created");
	assert.equal(q.breakdown, "service");
	assert.deepEqual(q.range, { preset: "30d" });
	assert.equal(q.interval, "auto");
	assert.equal(q.compare, "none");
	const c = query.parseSeriesQuery({
		metric: "fill_rate",
		from: "2026-01-01",
		to: "2026-03-31",
		compare: "previous",
	});
	assert.equal(c.range.preset, "custom");
});

test("hostile series queries are refused with the field named", () => {
	const field = (input: Record<string, unknown>) => {
		try {
			query.parseSeriesQuery(input);
		} catch (error) {
			assert.ok(error instanceof query.AnalyticsQueryError);
			return (error as InstanceType<typeof query.AnalyticsQueryError>).field;
		}
		assert.fail(`accepted ${JSON.stringify(input)}`);
	};
	assert.equal(field({}), "metric");
	assert.equal(field({ metric: "constructor" }), "metric");
	assert.equal(field({ metric: "__proto__" }), "metric");
	assert.equal(field({ metric: { $ne: null } }), "metric");
	assert.equal(field({ metric: ["bookings_created", "paid_value"] }), "metric");
	assert.equal(field({ metric: "bookings_created", $where: "1" }), "$where");
	assert.equal(field({ metric: "bookings_created", breakdown: "password" }), "breakdown");
	assert.equal(field({ metric: "bookings_created", breakdown: "cancelledBy" }), "breakdown"); // not for this metric
	assert.equal(field({ metric: "bookings_created", interval: "hour" }), "interval");
	assert.equal(field({ metric: "bookings_created", tz: "Mars/Olympus" }), "tz");
	assert.equal(field({ metric: "bookings_created", tz: "../../etc" }), "tz");
	assert.equal(field({ metric: "bookings_created", from: "2026-01-01" }), "to");
	assert.equal(field({ metric: "bookings_created", from: "2026-02-30", to: "2026-03-01" }), "from");
	assert.equal(field({ metric: "bookings_created", from: "2026-03-01", to: "2026-02-01" }), "from");
	assert.equal(field({ metric: "bookings_created", from: "1970-01-01", to: "2026-02-01" }), "from");
	assert.equal(field({ metric: "bookings_created", range: "30d", from: "2026-01-01", to: "2026-01-02" }), "range");
	assert.equal(field({ metric: "bookings_created", range: "9999d" }), "range");
	assert.equal(field({ metric: "bookings_created", stat: "p99" }), "stat");
	assert.equal(field({ metric: "bookings_created", compare: "x".repeat(101) }), "compare");
	assert.equal(field({ metric: "bookings_created\u0000" }), "metric");
});

test("summary queries take a bounded list of known metrics", () => {
	assert.equal(query.parseSummaryQuery({}).metrics.length, query.DEFAULT_SUMMARY_METRICS.length);
	assert.deepEqual(
		query.parseSummaryQuery({ metrics: "paid_value, paid_value,refunds" }).metrics.map((m) => m.id),
		["paid_value", "refunds"],
	);
	assert.throws(() => query.parseSummaryQuery({ metrics: "paid_value,drop" }), /Unknown metric/);
	assert.throws(() => query.parseSummaryQuery({ metrics: Array(30).fill("paid_value").join(",") }), /metrics/);
	assert.throws(() => query.intParam({ months: "-1" }, "months", 1, 36, 12), /whole number/);
	assert.throws(() => query.intParam({ months: "1e3" }, "months", 1, 36, 12), /whole number/);
});

test("cache keys do not depend on parameter order", () => {
	assert.equal(query.cacheKey("m", { a: 1, b: "x" }), query.cacheKey("m", { b: "x", a: 1 }));
	assert.notEqual(query.cacheKey("m", { a: 1 }), query.cacheKey("m", { a: 2 }));
});

test("saved views: a name and a whitelisted query; unknown fields refused", () => {
	const body = views.parseViewBody(
		{ name: "  Weekly   paid value ", query: { metric: "paid_value", interval: "week", chart: "bar" } },
		false,
	);
	assert.equal(body.name, "Weekly paid value");
	assert.equal(body.query!.metric, "paid_value");
	assert.equal(body.query!.breakdown, null);
	assert.throws(() => views.parseViewBody({ name: "x", query: { metric: "nope" } }, false), /metric/);
	assert.throws(() => views.parseViewBody({ name: "", query: { metric: "paid_value" } }, false), /name/);
	assert.throws(() => views.parseViewBody({ name: "x".repeat(81), query: { metric: "paid_value" } }, false), /name/);
	assert.throws(() => views.parseViewBody({ name: "x", query: { metric: "paid_value", $set: 1 } }, false), /Unknown/);
	assert.throws(() => views.parseViewBody({ name: "x", ownerId: "y", query: { metric: "paid_value" } }, false));
	assert.throws(() =>
		views.parseViewBody({ name: "x", query: { metric: "paid_value", breakdown: "cancelledBy" } }, false),
	);
	assert.throws(() => views.parseViewBody({ name: "x", query: { metric: "paid_value", from: "2026-01-01" } }, false));
	assert.throws(() => views.parseViewBody({ shared: "yes" }, true), /shared/);
	assert.throws(() => views.parseViewBody({}, true), /Send/);
	assert.deepEqual(views.parseViewBody({ shared: true }, true), { shared: true });
});

// ---------------------------------------------------------------------------------------------------------------
// Cache

test("the cache serves within its lifetime, recomputes after it, drops failures and stays bounded", async () => {
	let clock = 0;
	const cache = new TtlCache<number>(1000, 2, () => clock);
	let calls = 0;
	const compute = async () => ++calls;
	assert.equal(await cache.get("a", compute), 1);
	assert.equal(await cache.get("a", compute), 1);
	clock = 1000;
	assert.equal(await cache.get("a", compute), 2);
	await assert.rejects(cache.get("bad", () => Promise.reject(new Error("x"))));
	assert.equal(await cache.get("bad", async () => 7), 7);
	await cache.get("c", compute);
	assert.ok(cache.size <= 2);
});

// ---------------------------------------------------------------------------------------------------------------
// Metric definitions and series assembly

test("every metric is complete, unique and its breakdowns are supported by its source", () => {
	const ids = new Set<string>();
	for (const def of metrics.METRICS) {
		assert.ok(!ids.has(def.id), `${def.id} unique`);
		ids.add(def.id);
		assert.ok(def.label && def.description && def.computation, def.id);
		assert.ok(metrics.UNITS.includes(def.unit), def.id);
		if (def.kind === "aggregate") {
			for (const b of def.breakdowns)
				assert.ok(metrics.breakdownPlan(def.source.collection, b), `${def.id} by ${b}`);
		}
		if (def.kind === "derived") for (const id of def.of) assert.ok(metrics.metricById(id), `${def.id} uses ${id}`);
	}
	for (const required of [
		"bookings_created",
		"bookings_paid",
		"bookings_accepted",
		"bookings_completed",
		"bookings_cancelled",
		"bookings_expired",
		"paid_value",
		"completed_value",
		"platform_fees",
		"take_rate",
		"refunds",
		"net_revenue",
		"fill_rate",
		"time_to_accept",
		"time_to_start",
		"time_to_complete",
		"new_customers",
		"new_providers",
		"active_customers",
		"active_providers",
		"repeat_booking_rate",
		"avg_booking_value",
		"avg_hours",
		"avg_hourly_rate",
		"provider_utilisation",
		"applications_received",
		"applications_approved",
		"time_to_review",
		"sign_ins",
	]) {
		assert.ok(ids.has(required), required);
	}
});

const range5 = () => periods.resolveRange(day("2026-11-01"), day("2026-11-05"), "UTC", "day");
const at = (d: string) => new Date(`${d}T12:00:00Z`);

test("assemble: counts fill empty days with 0, rates with null, and totals come from parts", () => {
	const r = range5();
	const count = metrics.metricById("bookings_created") as import("../lib/analytics/metrics").AggregateMetric;
	const a = compute.assemble(count, r, [
		{ t: at("2026-11-01"), k: null, n: 2 },
		{ t: at("2026-11-04"), k: null, n: 1 },
	]);
	assert.deepEqual(a.values, [2, 0, 0, 1, 0]);
	assert.equal(a.total, 3);
	const ratio = metrics.metricById("fill_rate") as import("../lib/analytics/metrics").AggregateMetric;
	const b = compute.assemble(ratio, r, [
		{ t: at("2026-11-01"), k: null, n: 4, s: 3, d: 4 },
		{ t: at("2026-11-02"), k: null, n: 1, s: 0, d: 1 },
	]);
	assert.deepEqual(b.values, [75, 0, null, null, null]);
	assert.equal(b.total, 60);
	const dist = metrics.metricById("time_to_accept") as import("../lib/analytics/metrics").AggregateMetric;
	const c = compute.assemble(dist, r, [
		{ t: at("2026-11-01"), k: null, n: 2, vals: [100, 300] },
		{ t: at("2026-11-03"), k: null, n: 1, vals: [1000] },
	]);
	assert.deepEqual(c.values, [200, null, 1000, null, null]);
	assert.equal(c.total, 300); // the median of all three, not of the medians
	assert.equal(compute.assemble(dist, r, [], "p90").total, null);
});

test("assemble: distinct totals use whole-range rows; breakdowns keep the biggest keys and merge the rest", () => {
	const r = range5();
	const distinct = metrics.metricById("active_customers") as import("../lib/analytics/metrics").AggregateMetric;
	const a = compute.assemble(
		distinct,
		r,
		[
			{ t: at("2026-11-01"), k: null, n: 2, ids: ["a", "b"] },
			{ t: at("2026-11-02"), k: null, n: 2, ids: ["a", "c"] },
		],
		"p50",
		[{ t: null, k: null, n: 4, ids: ["a", "b", "c"] }],
	);
	assert.deepEqual(a.values, [2, 2, 0, 0, 0]);
	assert.equal(a.total, 3);

	const count = metrics.metricById("bookings_created") as import("../lib/analytics/metrics").AggregateMetric;
	const rows = Array.from({ length: 10 }, (_, i) => ({ t: at("2026-11-02"), k: `city${i}`, n: 10 - i }));
	const b = compute.assemble(count, r, rows);
	assert.equal(b.series.length, metrics.MAX_BREAKDOWN_SERIES + 1);
	assert.equal(b.series[0].key, "city0");
	const other = b.series[b.series.length - 1];
	assert.equal(other.key, "other");
	assert.equal(other.total, 2 + 1);
	assert.equal(b.total, 55);
});

test("derived metrics combine per bucket and in total; utilisation needs the provider count", () => {
	const inputs = [
		{ values: [10, null, 0], total: 10, series: [], count: 1 },
		{ values: [200, 50, 0], total: 250, series: [], count: 1 },
	];
	const take = metrics.metricById("take_rate") as import("../lib/analytics/metrics").DerivedMetric;
	assert.deepEqual(compute.combineDerived(take.combine, inputs, {}, 1), { values: [5, null, null], total: 4 });
	const util = metrics.metricById("provider_utilisation") as import("../lib/analytics/metrics").DerivedMetric;
	assert.equal(compute.combineDerived(util.combine, [inputs[0]], { approvedProviders: 40 }, 1).total, 25);
	assert.equal(compute.combineDerived(util.combine, [inputs[0]], { approvedProviders: 0 }, 1).total, null);
});

test("repeat-booking rate: earlier history or two bookings in a bucket make a repeat", () => {
	const r = range5();
	const out = compute.repeatRates(r, [
		{ first: at("2026-10-01"), inRange: [at("2026-11-01")] }, // booked before: repeat
		{ first: at("2026-11-01"), inRange: [at("2026-11-01")] }, // first ever: new
		{ first: at("2026-11-02"), inRange: [at("2026-11-02"), new Date("2026-11-02T15:00:00Z")] }, // twice: repeat
		{ first: at("2026-11-01"), inRange: [at("2026-11-01"), at("2026-11-04")] }, // new, then repeat on the 4th
	]);
	assert.deepEqual(out.values, [33.3, 100, null, 100, null]);
	assert.equal(out.total, 75);
});

// ---------------------------------------------------------------------------------------------------------------
// Pipeline shapes

const r30 = () => periods.resolveRange(day("2026-11-01"), day("2026-11-30"), "Europe/London", "week");

test("a series pipeline matches the indexed range first, caps the scan, buckets in the zone and groups parts", () => {
	const r = r30();
	const def = metrics.metricById("paid_value") as import("../lib/analytics/metrics").AggregateMetric;
	const p = metrics.buildSeriesPipeline(def, { start: r.start, end: r.end, interval: "week", tz: r.tz }) as any[];
	assert.deepEqual(Object.keys(p[0]), ["$match"]);
	assert.equal(p[0].$match.status, "completed");
	assert.deepEqual(p[0].$match.$or, [
		{ paidAt: { $gte: r.start, $lt: r.end } },
		{ paidAt: null, createdAt: { $gte: r.start, $lt: r.end } },
	]);
	assert.deepEqual(p[1], { $limit: metrics.MAX_SCAN });
	const project = p.find((s) => s.$project && s.$project.t)!.$project;
	assert.deepEqual(project.t.$dateTrunc, {
		date: { $ifNull: ["$paidAt", "$createdAt"] },
		unit: "week",
		timezone: "Europe/London",
		startOfWeek: "monday",
	});
	assert.equal(project.v, "$amount");
	const group = p.find((s) => s.$group)!.$group;
	assert.deepEqual(group._id, { t: "$t", k: "$k" });
	assert.ok(group.s && !group.vals && !group.ids);
	assert.equal(
		p.some((s) => s.$lookup),
		false,
		"no join without a breakdown",
	);
});

test("breakdowns add only the joins they need; unsupported ones are refused", () => {
	const r = r30();
	const input = { start: r.start, end: r.end, interval: "day" as const, tz: "UTC" };
	const created = metrics.metricById("bookings_created") as import("../lib/analytics/metrics").AggregateMetric;
	const byService = metrics.buildSeriesPipeline(created, { ...input, breakdown: "service" }) as any[];
	assert.equal(byService.filter((s) => s.$lookup).length, 0);
	const byCity = metrics.buildSeriesPipeline(created, { ...input, breakdown: "city" }) as any[];
	assert.deepEqual(
		byCity.filter((s) => s.$lookup).map((s) => s.$lookup.from),
		["users"],
	);
	const byPlatform = metrics.buildSeriesPipeline(created, { ...input, breakdown: "platform" }) as any[];
	const lookup = byPlatform.find((s) => s.$lookup).$lookup;
	assert.equal(lookup.from, "events");
	assert.deepEqual(lookup.pipeline[0], { $match: { type: "booking.created" } });
	assert.throws(() => metrics.buildSeriesPipeline(created, { ...input, breakdown: "cancelledBy" }));
});

test("distinct and distribution metrics collect ids and values; fill rate keeps only paid, decided bookings", () => {
	const r = r30();
	const input = { start: r.start, end: r.end, interval: "day" as const, tz: "UTC", now: new Date("2026-11-20Z") };
	const active = metrics.buildSeriesPipeline(
		metrics.metricById("active_providers") as import("../lib/analytics/metrics").AggregateMetric,
		input,
	) as any[];
	assert.equal(active[0].$match["actor.type"], "provider");
	assert.deepEqual(active.find((s) => s.$group).$group.ids, { $addToSet: "$i" });
	const totals = metrics.buildSeriesPipeline(
		metrics.metricById("active_providers") as import("../lib/analytics/metrics").AggregateMetric,
		input,
		false,
	) as any[];
	assert.equal(totals.find((s) => s.$project && "t" in s.$project).$project.t, null);
	const dist = metrics.buildSeriesPipeline(
		metrics.metricById("time_to_accept") as import("../lib/analytics/metrics").AggregateMetric,
		input,
	) as any[];
	assert.deepEqual(dist.find((s) => s.$group).$group.vals, { $push: "$v" });
	const fill = metrics.buildSeriesPipeline(
		metrics.metricById("fill_rate") as import("../lib/analytics/metrics").AggregateMetric,
		input,
	) as any[];
	assert.equal(fill[0].$match.startDate.$gte, r.start);
	const paid = fill.find((s) => s.$lookup)?.$lookup;
	assert.equal(paid.from, "payments");
	assert.deepEqual(paid.pipeline[0], { $match: { status: "completed" } });
	assert.ok(fill.some((s) => s.$match && s.$match["_paid.0"]));
});

test("report pipelines start with a bounded, indexed match and a scan cap", () => {
	const start = new Date("2026-11-01Z");
	const end = new Date("2026-12-01Z");
	const all = [
		reports.customerFunnelPipeline(start, end),
		reports.providerFunnelPipeline(start, end),
		reports.customerCohortPipeline(end, "UTC"),
		reports.providerCohortPipeline(end, "UTC"),
		reports.demandGridPipeline(start, end, "UTC", 2),
		reports.supplyGridPipeline(start, end, "UTC", null),
		reports.demandAreaPipeline(start, end, null),
		reports.supplyAreaPipeline(1),
		reports.customerLeaderboardPipeline(start, end, "value", 10),
		reports.providerLeaderboardPipeline(start, end, "count", 10),
		reports.repeatBookingPipeline(start, end),
		...Object.keys(reports.DISTRIBUTIONS).map((id) =>
			reports.distributionPipeline(id as import("../lib/analytics/reports").DistributionId, start, end),
		),
	] as any[][];
	for (const p of all) {
		assert.ok(p[0].$match, JSON.stringify(p[0]).slice(0, 80));
		assert.ok(
			p.slice(0, 3).some((s) => s.$limit === metrics.MAX_SCAN),
			JSON.stringify(p[0]).slice(0, 80),
		);
	}
	assert.deepEqual(reports.customerFunnelPipeline(start, end)[0].$match, {
		"roles.User": true,
		createdAt: { $gte: start, $lt: end },
	});
	assert.equal((reports.demandGridPipeline(start, end, "UTC", 2)[0] as any).$match["service.id"], 2);
	const grid = reports.demandGridPipeline(start, end, "Europe/London", null) as any[];
	assert.deepEqual(grid[2].$group._id.d, { $isoDayOfWeek: { date: "$startDate", timezone: "Europe/London" } });
	const leaders = reports.customerLeaderboardPipeline(start, end, "count", 5) as any[];
	assert.ok(leaders.some((s) => s.$limit === 5));
	assert.deepEqual(leaders.find((s) => s.$sort).$sort, { count: -1, value: -1, _id: 1 });
});

test("CSV cells neutralise formulas and quote separators", () => {
	/* eslint-disable-next-line @typescript-eslint/no-require-imports */
	const { csvCell } = require("../controllers/admin/analytics.controller");
	assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
	assert.equal(csvCell("a,b"), '"a,b"');
	assert.equal(csvCell('say "hi"'), '"say ""hi"""');
	assert.equal(csvCell(-5), "-5");
	assert.equal(csvCell(null), "");
});

test("analytics routes: signed in, analytics.read, rate limited, writes audited", () => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const admin = require("../routes/admin.route").default;
	const { verifyAdminJWT } = require("../middleware/verifyAdminJWT");
	const { analyticsLimiter } = require("../routes/adminAnalytics.route");
	const { auditActionsOf } = require("../middleware/audited");
	/* eslint-enable @typescript-eslint/no-require-imports */
	const routes = (admin.stack as any[])
		.filter((l) => l.route?.path.startsWith("/analytics"))
		.map((l) => ({
			id: `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`,
			handles: l.route.stack.map((s: any) => s.handle),
		}));
	assert.equal(routes.length, 13);
	for (const r of routes) {
		assert.equal(r.handles[0], verifyAdminJWT, r.id);
		assert.equal(r.handles[1].permission, "analytics.read", r.id);
		assert.equal(r.handles[2], analyticsLimiter, r.id);
		if (!r.id.startsWith("GET")) assert.ok(auditActionsOf(r.handles[r.handles.length - 1])?.length, r.id);
	}
});
