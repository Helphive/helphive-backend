// Pure parts of the observability module: histograms and percentiles, the request aggregator, fingerprints,
// scrubbing, the evaluator lease (injected clock), alert rules, replay eligibility, log and client-report validation,
// and the route wiring. No network, database or timers.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

delete process.env.DATABASE_URI;
mongoose.set("bufferCommands", false);
process.env.STRIPE_SECRET_KEY ??= "sk_test_wiring_only";

import {
	BUCKET_COUNT,
	LATENCY_BOUNDS_MS,
	addToHistogram,
	bucketFor,
	histogramCount,
	mergeHistograms,
	percentile,
	percentiles,
} from "../lib/observability/histogram";
import { RequestMetricsAggregator, metricUpsert, OVERFLOW_ROUTE } from "../lib/observability/requestMetrics";
import {
	culpritOf,
	fingerprintOf,
	isNewerRevision,
	normalizeMessage,
	parseStack,
	revisionNumber,
	topFrames,
} from "../lib/observability/fingerprint";
import { scrubRoute, scrubText } from "../lib/observability/scrub";
import { Lease, MemoryLeaseStore, canTakeLease } from "../lib/observability/lease";
import {
	DEFAULT_RULES,
	RuleInputError,
	alertTransition,
	evaluateRule,
	parseRuleInput,
	simulateRule,
	type MinuteMeasures,
} from "../lib/observability/alertRules";
import { taskReplayEligibility, webhookReplayEligibility } from "../lib/observability/replay";
import {
	buildLogFilter,
	compactLogEntry,
	logsConsoleLink,
	parseLogQuery,
	traceLink,
} from "../lib/observability/logQuery";
import { ListQueryError } from "../lib/listQuery";
import { ErrorBuffer, groupUpdate, prepareCapture } from "../lib/observability/errorTracker";
import { downMinutes } from "../lib/observability/dependencies";
import { parseRange } from "../lib/observability/queries";

// --- Histograms ---------------------------------------------------------------------------------------------------

test("bucketFor puts each latency in the bucket whose upper bound it does not exceed", () => {
	assert.equal(bucketFor(0), 0);
	assert.equal(bucketFor(5), 0);
	assert.equal(bucketFor(5.1), 1);
	assert.equal(bucketFor(100), LATENCY_BOUNDS_MS.indexOf(100));
	assert.equal(bucketFor(101), LATENCY_BOUNDS_MS.indexOf(150));
	assert.equal(bucketFor(1e9), BUCKET_COUNT - 1);
	assert.equal(bucketFor(Number.NaN), 0);
});

test("merging histograms adds buckets exactly and drops malformed entries", () => {
	const a = addToHistogram(addToHistogram({}, 3), 120);
	const b = addToHistogram({}, 120, 4);
	const merged = mergeHistograms(a, b, null, { "999": 5, "-1": 2, x: 3, "2": -4 } as any);
	assert.deepEqual(merged, { "0": 1, [String(bucketFor(120))]: 5 });
	assert.equal(histogramCount(merged), 6);
	// Order does not matter, and merging is the same as recording everything in one histogram.
	assert.deepEqual(mergeHistograms(b, a), merged);
	const single = {};
	for (const ms of [3, 120, 120, 120, 120, 120]) addToHistogram(single, ms);
	assert.deepEqual(single, merged);
});

test("percentiles interpolate inside the bucket and stay within its bounds", () => {
	const h = {};
	for (let i = 0; i < 100; i++) addToHistogram(h, i < 90 ? 40 : 900); // 90 in (25,50], 10 in (750,1000]
	const p50 = percentile(h, 50)!;
	assert.ok(p50 > 25 && p50 <= 50, `p50 ${p50}`);
	const p95 = percentile(h, 95)!;
	assert.ok(p95 > 750 && p95 <= 1000, `p95 ${p95}`);
	assert.equal(percentile({}, 50), null);
	assert.equal(percentile(null, 50), null);
	// The open last bucket is capped by the observed maximum.
	const slow = addToHistogram({}, 45_000);
	assert.equal(percentile(slow, 100, 45_000), 45_000);
	assert.ok(percentile(slow, 100)! <= 60_000);
	const all = percentiles(h);
	assert.ok(all.p50! <= all.p95! && all.p95! <= all.p99!);
});

test("percentile of merged per-instance histograms equals the percentile of all samples together", () => {
	const instances = [{}, {}, {}];
	const together = {};
	let seed = 7;
	for (let i = 0; i < 3000; i++) {
		seed = (seed * 48271) % 2147483647;
		const ms = (seed % 4000) / 3;
		addToHistogram(instances[i % 3], ms);
		addToHistogram(together, ms);
	}
	const merged = mergeHistograms(...instances);
	for (const p of [50, 90, 95, 99]) assert.equal(percentile(merged, p), percentile(together, p));
});

// --- Aggregator ---------------------------------------------------------------------------------------------------

test("the aggregator counts by minute, route, method and status class, and builds $inc upserts", () => {
	let now = Date.UTC(2026, 10, 19, 10, 0, 30);
	const agg = new RequestMetricsAggregator(() => now);
	const sample = { route: "/admin/users/:id", method: "get", revision: "helphive-00042-abc" };
	agg.record({ ...sample, status: 200, latencyMs: 12 });
	agg.record({ ...sample, status: 503, latencyMs: 1200 });
	agg.record({ ...sample, status: 429, latencyMs: 2 });
	now += 60_000;
	agg.record({ ...sample, status: 302, latencyMs: 30 });
	const cells = agg.drain();
	assert.equal(cells.length, 2);
	const first = cells.find((c) => c.m === Date.UTC(2026, 10, 19, 10, 0))!;
	assert.deepEqual(
		{ n: first.n, s2: first.s2, s4: first.s4, s5: first.s5, rl: first.rl, max: first.max, mt: first.mt },
		{ n: 3, s2: 1, s4: 1, s5: 1, rl: 1, max: 1200, mt: "GET" },
	);
	assert.equal(histogramCount(first.h), 3);
	assert.equal(agg.size, 0);
	const op = metricUpsert(first, 30 * 86_400_000).updateOne;
	assert.equal(op.upsert, true);
	assert.equal(op.update.$inc.n, 3);
	assert.equal(op.update.$max.max, 1200);
	assert.ok(Object.keys(op.update.$inc).some((k) => k.startsWith("h.")));
	assert.equal(op.update.$setOnInsert.expireAt.getTime(), first.m + 30 * 86_400_000);
});

test("the aggregator caps its memory and restores cells after a failed write", () => {
	const agg = new RequestMetricsAggregator(() => 0, 2);
	for (const route of ["/a", "/b", "/c", "/d"])
		agg.record({ route, method: "GET", status: 200, latencyMs: 1, revision: "r" });
	const cells = agg.drain();
	assert.equal(cells.length, 3);
	assert.equal(cells.find((c) => c.r === OVERFLOW_ROUTE)?.n, 2);
	agg.record({ route: "/a", method: "GET", status: 500, latencyMs: 9, revision: "r" });
	agg.restore(cells);
	const again = agg.drain();
	assert.equal(again.find((c) => c.r === "/a")?.n, 2);
});

// --- Fingerprints -------------------------------------------------------------------------------------------------

const nodeStack = (
	line: number,
	id: string,
) => `TypeError: Cannot read properties of undefined (reading 'amount') for ${id}
    at refundTotals (/app/dist/lib/operations.js:${line}:17)
    at handleRefundPayment (/app/dist/controllers/admin/payments.controller.js:200:9)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`;

test("fingerprints ignore ids, numbers, line numbers and library frames", () => {
	const a = fingerprintOf({
		source: "server",
		type: "TypeError",
		message: "Booking 65f0a1b2c3d4e5f6a7b8c9d0 not found (42)",
		stack: nodeStack(10, "x"),
	});
	const b = fingerprintOf({
		source: "server",
		type: "TypeError",
		message: "Booking 65f0a1b2c3d4e5f6a7b8c9ff not found (7)",
		stack: nodeStack(99, "y"),
	});
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{16}$/);
	const other = fingerprintOf({
		source: "server",
		type: "RangeError",
		message: "Booking x not found",
		stack: nodeStack(10, "x"),
	});
	assert.notEqual(a, other);
	// Without a stack the route separates groups.
	const r1 = fingerprintOf({ source: "server", type: "HTTP 500", message: "", route: "/a" });
	const r2 = fingerprintOf({ source: "server", type: "HTTP 500", message: "", route: "/b" });
	assert.notEqual(r1, r2);
	// Client platforms are separate codebases.
	const web = fingerprintOf({ source: "client", platform: "web", message: "boom" });
	const ios = fingerprintOf({ source: "client", platform: "ios", message: "boom" });
	assert.notEqual(web, ios);
});

test("normalizeMessage replaces variable parts", () => {
	assert.equal(
		normalizeMessage('User a@b.com pi_3Nxyz failed at 10.0.0.1 with "secret" after 250ms 9f86d081884c7d65'),
		"User <email> <stripe-id> failed at <ip> with <str> after <n>ms <hex>",
	);
});

test("stack parsing keeps app frames, strips hashes from bundle names and minified function names", () => {
	assert.deepEqual(topFrames(nodeStack(1, "z"), 3), [
		{ fn: "refundTotals", file: "/dist/lib/operations.js" },
		{ fn: "handleRefundPayment", file: "/dist/controllers/admin/payments.controller.js" },
	]);
	assert.equal(culpritOf(nodeStack(1, "z")), "refundTotals (/dist/lib/operations.js)");
	const browser =
		"Error: x\n    at Xe (https://admin.helphive.himaiz.com/assets/index-3fA9c2bD.js:1:2345)\n    at renderPage (https://admin.helphive.himaiz.com/assets/Page-a1b2c3d4.js:3:4)";
	assert.deepEqual(parseStack(browser), [
		{ fn: "", file: "/assets/index.js" },
		{ fn: "renderPage", file: "/assets/Page.js" },
	]);
	const gecko = "renderPage@https://helphive.himaiz.com/assets/Page-a1b2c3d4.js:3:4";
	assert.deepEqual(parseStack(gecko), [{ fn: "renderPage", file: "/assets/Page.js" }]);
});

test("revision ordering follows Cloud Run's sequence numbers", () => {
	assert.equal(revisionNumber("helphive-00042-xyz"), 42);
	assert.equal(revisionNumber("local"), null);
	assert.equal(isNewerRevision("helphive-00043-aaa", "helphive-00042-xyz"), true);
	assert.equal(isNewerRevision("helphive-00041-aaa", "helphive-00042-xyz"), false);
	assert.equal(isNewerRevision("helphive-00042-xyz", "helphive-00042-xyz"), false);
	assert.equal(isNewerRevision("other", null), true);
});

// --- Scrubbing ----------------------------------------------------------------------------------------------------

test("scrubbing removes credentials, emails, addresses, IPs, long numbers and query strings", () => {
	const text = scrubText(
		"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk failed for jane.doe@example.com at 10.1.2.3 " +
			"https://helphive.himaiz.com/reset-password?token=abc123#x card 4242 4242 4242 4242 lives at 221 Baker Street " +
			"password=hunter2 sk_live_abcdefghijkl pi_123_secret_456 token: zzz",
	);
	for (const leaked of [
		"eyJ",
		"jane.doe",
		"10.1.2.3",
		"token=abc123",
		"4242 4242",
		"Baker Street",
		"hunter2",
		"sk_live",
		"pi_123_secret",
		"zzz",
	]) {
		assert.ok(!text.includes(leaked), `${leaked} leaked: ${text}`);
	}
	assert.ok(text.includes("https://helphive.himaiz.com/reset-password"));
	assert.equal(scrubText("x".repeat(5000), 100).length, 100);
	assert.equal(scrubText(undefined), "");
});

test("scrubRoute keeps the shape of a route without ids or queries", () => {
	assert.equal(scrubRoute("/bookings/65f0a1b2c3d4e5f6a7b8c9d0/pay?session=x"), "/bookings/:id/pay");
	assert.equal(scrubRoute("https://helphive.himaiz.com/users/123/edit#tab"), "/users/:id/edit");
	assert.equal(scrubRoute("BookingDetails"), "BookingDetails");
	assert.equal(scrubRoute("/u/a@b.com"), "/u/:id");
	assert.equal(scrubRoute(""), null);
	assert.equal(scrubRoute(42), null);
});

// --- Error tracker ------------------------------------------------------------------------------------------------

test("captures are scrubbed and grouped, users counted once, occurrences sampled", () => {
	let now = 0;
	const buffer = new ErrorBuffer(() => now);
	const base = {
		source: "client" as const,
		platform: "web",
		message: "Failed for a@b.com",
		stack: null,
		route: "/bookings/65f0a1b2c3d4e5f6a7b8c9d0",
		revision: "r1",
	};
	const fp = buffer.add({ ...base, userId: "u1", appVersion: "1.2.0" });
	buffer.add({ ...base, userId: "u1", appVersion: "1.2.1" });
	buffer.add({ ...base, adminId: "a1" });
	now += 61_000;
	buffer.add({ ...base });
	const { groups, occurrences } = buffer.drain();
	assert.equal(groups.length, 1);
	assert.equal(groups[0].fingerprint, fp);
	assert.equal(groups[0].count, 4);
	assert.deepEqual([...groups[0].users].sort(), ["admin:a1", "u1"]);
	assert.deepEqual([...groups[0].appVersions], ["1.2.0", "1.2.1"]);
	assert.equal(groups[0].lastAppVersion, "1.2.1");
	assert.equal(groups[0].route, "/bookings/:id");
	assert.ok(!groups[0].message.includes("a@b.com"));
	assert.equal(occurrences.length, 2, "first per minute per group");
	assert.equal(buffer.groups.size, 0);
});

test("prepareCapture titles 5xx answers without an error by status", () => {
	const prepared = prepareCapture({ source: "server", status: 502, method: "GET", route: "/admin/x", revision: "r" });
	assert.equal(prepared.type, "HTTP 502");
	assert.equal(prepared.platform, "server");
	assert.ok(prepared.title.startsWith("HTTP 502"));
});

test("the group upsert reopens resolved groups only for a newer revision", () => {
	const group = {
		fingerprint: "f",
		source: "server" as const,
		platform: "server",
		type: "E",
		title: "E: x",
		message: "x",
		culprit: null,
		route: "/r",
		count: 2,
		users: new Set(["u"]),
		appVersions: new Set<string>(),
		lastAppVersion: null,
		firstAt: new Date(0),
		lastAt: new Date(1000),
		revision: "helphive-00043-abc",
	};
	const pipeline = groupUpdate(group, 1000) as any[];
	const reopen = JSON.stringify(pipeline[0].$set._reopen);
	assert.ok(reopen.includes('"resolved"') && reopen.includes("resolvedRevisionNumber") && reopen.includes("43"));
	assert.equal(pipeline[1].$set.count.$add[1], 2);
	assert.equal(pipeline[1].$set.expireAt.getTime(), 2000);
	assert.deepEqual(pipeline[3], { $unset: "_reopen" });
});

// --- Lease --------------------------------------------------------------------------------------------------------

test("only one holder has the lease until it expires; the holder renews; release frees it", async () => {
	let now = new Date("2026-11-19T10:00:00Z");
	const clock = () => now;
	const store = new MemoryLeaseStore();
	const a = new Lease(store, "evaluator", "instance-a", 180_000, clock);
	const b = new Lease(store, "evaluator", "instance-b", 180_000, clock);
	assert.equal(await a.acquire(), true);
	assert.equal(await b.acquire(), false);
	now = new Date(now.getTime() + 60_000);
	assert.equal(await a.acquire(), true, "renewal");
	now = new Date(now.getTime() + 179_000);
	assert.equal(await b.acquire(), false, "renewed lease still valid");
	now = new Date(now.getTime() + 2_000);
	assert.equal(await b.acquire(), true, "expired: taken over");
	assert.equal(await a.acquire(), false);
	await a.release();
	assert.equal(store.leases.get("evaluator")?.holder, "instance-b", "a cannot release b's lease");
	await b.release();
	assert.equal(await a.acquire(), true);
	assert.equal(canTakeLease(null, "x", now), true);
	const failing = new Lease(
		{
			tryTake: async () => {
				throw new Error("db");
			},
			release: async () => undefined,
		},
		"e",
		"h",
		1,
		clock,
	);
	assert.equal(await failing.acquire(), false, "a store failure never grants the lease");
});

// --- Alert rules --------------------------------------------------------------------------------------------------

test("rule input is validated field by field and updates keep the kind", () => {
	const rule = parseRuleInput({
		name: "Errors",
		kind: "error_rate",
		threshold: "2.5",
		minutes: 10,
		recipients: ["65f0a1b2c3d4e5f6a7b8c9d0"],
	});
	assert.equal(rule.threshold, 2.5);
	assert.equal(rule.enabled, false);
	assert.equal(rule.minRequests, 20);
	const bad = (body: unknown, field: string, base?: any) =>
		assert.throws(
			() => parseRuleInput(body, base),
			(e: unknown) => e instanceof RuleInputError && e.field === field,
		);
	bad({ name: "Errors", kind: "nope" }, "kind");
	bad({ name: "E", kind: "latency" }, "name");
	bad({ name: "Errors", kind: "error_rate", threshold: 200 }, "threshold");
	bad({ name: "Errors", kind: "latency", percentile: 90 }, "percentile");
	bad({ name: "Errors", kind: "latency", route: "users" }, "route");
	bad({ name: "Errors", kind: "latency", recipients: ["x"] }, "recipients");
	bad({ name: "Errors", kind: "latency", $where: 1 }, "$where");
	bad({ kind: "latency" }, "kind", rule);
	const updated = parseRuleInput({ enabled: true }, rule);
	assert.equal(updated.enabled, true);
	assert.equal(updated.threshold, 2.5);
	for (const d of DEFAULT_RULES) {
		const { key, ...rest } = d;
		assert.ok(key);
		assert.equal(parseRuleInput({ ...rest, recipients: [] }).enabled, false, `${d.name} is valid and disabled`);
	}
});

test("rule evaluation for each kind", () => {
	const h = {};
	for (let i = 0; i < 100; i++) addToHistogram(h, i < 50 ? 40 : 2500);
	assert.equal(
		evaluateRule({ kind: "error_rate", threshold: 5, minutes: 5, minRequests: 20 }, { requests: 100, errors: 6 })
			.breached,
		true,
	);
	assert.equal(
		evaluateRule({ kind: "error_rate", threshold: 5, minutes: 5, minRequests: 20 }, { requests: 10, errors: 10 })
			.breached,
		false,
		"too few requests",
	);
	assert.equal(
		evaluateRule(
			{ kind: "latency", threshold: 2000, minutes: 5, percentile: 95, minRequests: 1 },
			{ requests: 100, histogram: h, maxMs: 2500 },
		).breached,
		true,
	);
	assert.equal(
		evaluateRule(
			{ kind: "latency", threshold: 2000, minutes: 5, percentile: 50, minRequests: 1 },
			{ requests: 100, histogram: h },
		).breached,
		false,
	);
	assert.equal(
		evaluateRule({ kind: "webhook_failures", threshold: 1, minutes: 15 }, { webhookFailures: 1 }).breached,
		true,
	);
	assert.equal(
		evaluateRule({ kind: "task_failures", threshold: 2, minutes: 15 }, { taskFailures: 1 }).breached,
		false,
	);
	assert.equal(
		evaluateRule({ kind: "rate_limited", threshold: 100, minutes: 15 }, { rateLimited: 100 }).breached,
		true,
	);
	assert.equal(
		evaluateRule({ kind: "failed_sign_ins", threshold: 50, minutes: 15 }, { failedSignIns: 49 }).breached,
		false,
	);
	assert.equal(
		evaluateRule({ kind: "new_error_group", threshold: 1, minutes: 30 }, { newErrorGroups: 1 }).breached,
		true,
	);
	const deps = { dependencyDownMinutes: { stripe: 6, resend: 2 } };
	assert.equal(evaluateRule({ kind: "dependency_down", threshold: 1, minutes: 5 }, deps).breached, true);
	assert.equal(
		evaluateRule({ kind: "dependency_down", threshold: 1, minutes: 5, dependency: "resend" }, deps).breached,
		false,
	);
});

test("alert lifecycle: open, keep, resolve, cooldown", () => {
	const now = new Date("2026-11-19T10:00:00Z");
	assert.equal(alertTransition(null, true, null, 30, now), "open");
	assert.equal(alertTransition({ status: "firing" }, true, null, 30, now), "none");
	assert.equal(alertTransition({ status: "acknowledged" }, false, null, 30, now), "resolve");
	assert.equal(alertTransition(null, true, new Date(now.getTime() - 10 * 60_000), 30, now), "none", "in cooldown");
	assert.equal(alertTransition(null, true, new Date(now.getTime() - 31 * 60_000), 30, now), "open");
	assert.equal(alertTransition(null, false, null, 30, now), "none");
});

test("the preview counts separate firings over per-minute data, with windows and cooldown", () => {
	const minute = (over: Partial<MinuteMeasures> = {}): MinuteMeasures => ({
		requests: 100,
		errors: 0,
		rateLimited: 0,
		webhookFailures: 0,
		taskFailures: 0,
		failedSignIns: 0,
		newErrorGroups: 0,
		...over,
	});
	const data = [
		minute(),
		minute({ errors: 20 }),
		minute({ errors: 20 }),
		minute(),
		minute(),
		minute(),
		minute({ errors: 20 }),
		minute(),
	];
	const sim = simulateRule(
		{ kind: "error_rate", threshold: 5, minutes: 1, minRequests: 1, cooldownMinutes: 0 },
		data,
	);
	assert.deepEqual(
		{ episodes: sim.episodes, firing: sim.firingMinutes, opened: sim.openedAt },
		{ episodes: 2, firing: 3, opened: [1, 6] },
	);
	const cooled = simulateRule(
		{ kind: "error_rate", threshold: 5, minutes: 1, minRequests: 1, cooldownMinutes: 10 },
		data,
	);
	assert.equal(cooled.episodes, 1);
	const windowed = simulateRule(
		{ kind: "error_rate", threshold: 5, minutes: 3, minRequests: 1, cooldownMinutes: 0 },
		data,
	);
	assert.equal(windowed.firingMinutes > sim.firingMinutes, true, "a longer window keeps it firing longer");
	const down = simulateRule({ kind: "dependency_down", threshold: 1, minutes: 3, cooldownMinutes: 0 }, [
		minute({ down: { stripe: true } }),
		minute(),
		minute(),
		minute({ down: { stripe: false } }),
		minute(),
	]);
	assert.deepEqual(down.openedAt, [2]);
	assert.equal(simulateRule({ kind: "webhook_failures", threshold: 1, minutes: 5 }, []).episodes, 0);
});

test("downMinutes counts each dependency's unbroken run of failures", () => {
	const now = new Date("2026-11-19T10:00:00Z");
	const at = (min: number) => new Date(now.getTime() - min * 60_000);
	const result = downMinutes(
		[
			{ name: "stripe", status: "down", at: at(1) },
			{ name: "resend", status: "up", at: at(1) },
			{ name: "stripe", status: "down", at: at(6) },
			{ name: "stripe", status: "up", at: at(11) },
			{ name: "stripe", status: "down", at: at(16) },
		],
		now,
	);
	assert.deepEqual(result, { stripe: 6, resend: 0 });
});

// --- Replay -------------------------------------------------------------------------------------------------------

test("webhook replay only for failed (or stuck) idempotent Stripe events within Stripe's 30 days", () => {
	const now = new Date("2026-11-19T10:00:00Z");
	const ago = (ms: number) => new Date(now.getTime() - ms);
	const base = {
		provider: "stripe",
		eventId: "evt_1",
		type: "payout.paid",
		outcome: "failed",
		receivedAt: ago(60_000),
	};
	assert.equal(webhookReplayEligibility(base, now).eligible, true);
	assert.ok(webhookReplayEligibility(base, now).effect);
	assert.equal(webhookReplayEligibility({ ...base, outcome: "processed" }, now).eligible, false);
	assert.equal(webhookReplayEligibility({ ...base, outcome: "received" }, now).eligible, false, "still running");
	assert.equal(
		webhookReplayEligibility({ ...base, outcome: "received", receivedAt: ago(20 * 60_000) }, now).eligible,
		true,
		"stuck",
	);
	assert.equal(webhookReplayEligibility({ ...base, type: "payment_intent.payment_failed" }, now).eligible, false);
	assert.equal(webhookReplayEligibility({ ...base, type: "customer.created" }, now).eligible, false);
	assert.equal(
		webhookReplayEligibility({ ...base, receivedAt: ago(31 * 86_400_000) }, now).eligible,
		false,
		"too old",
	);
	assert.equal(webhookReplayEligibility({ ...base, provider: "other" }, now).eligible, false);
});

test("task replay only for failed or refused runs of known tasks with a booking id", () => {
	const run = { task: "earning-complete", outcome: "failed", bookingId: "65f0a1b2c3d4e5f6a7b8c9d0" };
	assert.equal(taskReplayEligibility(run).eligible, true);
	assert.equal(taskReplayEligibility({ ...run, outcome: "rejected" }).eligible, true);
	assert.equal(taskReplayEligibility({ ...run, outcome: "processed" }).eligible, false);
	assert.equal(taskReplayEligibility({ ...run, outcome: "skipped" }).eligible, false);
	assert.equal(taskReplayEligibility({ ...run, task: "unknown" }).eligible, false);
	assert.equal(taskReplayEligibility({ ...run, bookingId: null }).eligible, false);
	assert.equal(taskReplayEligibility({ ...run, bookingId: "nope" }).eligible, false);
});

// --- Logs ---------------------------------------------------------------------------------------------------------

test("log queries are validated and turned into a Cloud Logging filter and console link", () => {
	const now = new Date("2026-11-19T10:00:00Z");
	const q = parseLogQuery(
		{
			severity: "error",
			requestId: "abc12345-x",
			route: "/admin/users/:id",
			userId: "65f0a1b2c3d4e5f6a7b8c9d0",
			text: 'say "hi"',
		},
		now,
	);
	assert.equal(q.to.getTime(), now.getTime());
	assert.equal(now.getTime() - q.from.getTime(), 3_600_000);
	const filter = buildLogFilter(q, { project: "helphive", service: "helphive" });
	assert.ok(filter.includes('resource.labels.service_name="helphive"'));
	assert.ok(filter.includes("severity>=ERROR"));
	assert.ok(filter.includes('jsonPayload.requestId="abc12345-x"'));
	assert.ok(filter.includes('jsonPayload.route="/admin/users/:id"'));
	assert.ok(filter.includes('jsonPayload.adminId="65f0a1b2c3d4e5f6a7b8c9d0"'));
	assert.ok(filter.includes('"say \\"hi\\""'), "text is quoted and escaped");
	assert.ok(
		logsConsoleLink(filter, "helphive", q.from, q.to).startsWith(
			"https://console.cloud.google.com/logs/query;query=",
		),
	);
	const fails = (query: Record<string, unknown>, field: string) =>
		assert.throws(
			() => parseLogQuery(query, now),
			(e: unknown) => e instanceof ListQueryError && e.field === field,
			JSON.stringify(query),
		);
	fails({ severity: "LOUD" }, "severity");
	fails({ requestId: "bad id" }, "requestId");
	fails({ route: 'x" OR true' }, "route");
	fails({ userId: "me" }, "userId");
	fails({ text: "x".repeat(101) }, "text");
	fails({ from: "2026-01-01", to: "2026-03-01" }, "from");
	fails({ from: "2026-11-19T11:00:00Z" }, "from");
	fails({ pageSize: "500" }, "pageSize");
	fails({ severity: ["ERROR", "INFO"] }, "severity");
	fails({ other: "1" }, "other");
});

test("log entries are compacted with their trace link", () => {
	const entry = compactLogEntry(
		{
			insertId: "i1",
			timestamp: "2026-11-19T10:00:00Z",
			severity: "ERROR",
			trace: "projects/helphive/traces/0123456789abcdef0123456789abcdef",
			resource: { labels: { revision_name: "helphive-00042-abc" } },
			httpRequest: { requestMethod: "GET", requestUrl: "/admin/x", status: 500, latency: "0.250s" },
			jsonPayload: {
				message: "boom",
				requestId: "req-12345678",
				route: "/admin/x",
				error: { name: "TypeError", message: "x", stack: "s" },
			},
		},
		"helphive",
	);
	assert.equal(entry.message, "boom");
	assert.equal(entry.revision, "helphive-00042-abc");
	assert.deepEqual(entry.http, { method: "GET", url: "/admin/x", status: 500, latencyMs: 250 });
	assert.equal(entry.error?.name, "TypeError");
	assert.ok(entry.traceUrl?.includes("tid=0123456789abcdef0123456789abcdef"));
	assert.equal(traceLink("nope", "helphive"), null);
	assert.equal(compactLogEntry({ textPayload: "plain" }, "p").message, "plain");
	assert.equal(entry.event, null, "lines from before the logging standard");

	// A request line in the logging standard (msg, event, ray, method/route/status/ms).
	const line = compactLogEntry(
		{
			insertId: "i2",
			severity: "INFO",
			jsonPayload: {
				level: "info",
				app: "helphive",
				part: "api",
				event: "request",
				ray: "8a1b2c3d4e5f6a7b-LHR",
				msg: "GET /auth/user-details 200",
				route: "/auth/user-details",
				method: "GET",
				status: 200,
				ms: 37,
				userId: "64b7f0c2a1b2c3d4e5f60718",
			},
		},
		"helphive",
	);
	assert.equal(line.message, "GET /auth/user-details 200");
	assert.equal(line.event, "request");
	assert.equal(line.ray, "8a1b2c3d4e5f6a7b-LHR");
	assert.equal(line.userId, "64b7f0c2a1b2c3d4e5f60718");
	assert.deepEqual(line.http, { method: "GET", url: "/auth/user-details", status: 200, latencyMs: 37 });
});

test("metric ranges round to their bucket and refuse unknown names", () => {
	const window = parseRange("1h", "24h", Date.UTC(2026, 10, 19, 10, 0, 30));
	assert.equal(window.to.getTime(), Date.UTC(2026, 10, 19, 10, 1));
	assert.equal(window.to.getTime() - window.from.getTime(), 3_600_000);
	assert.equal(parseRange(undefined).range, "24h");
	assert.throws(() => parseRange("2y"), ListQueryError);
	assert.throws(() => parseRange(["1h"]), ListQueryError);
});

// --- Client reports and wiring -------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-require-imports */
const ops = require("../controllers/admin/observabilityOps.controller");
const adminRoute = require("../routes/admin.route").default;
const { auditActionsOf } = require("../middleware/audited");
const { verifyAdminJWT } = require("../middleware/verifyAdminJWT");
const { ROLE_PERMISSIONS } = require("../config/adminPermissions");
const obsRoutes = require("../routes/adminObservability.route");
const limiters = [
	obsRoutes.observabilityReadLimiter,
	obsRoutes.observabilityLogsLimiter,
	obsRoutes.observabilityWriteLimiter,
];
/* eslint-enable @typescript-eslint/no-require-imports */

test("client reports are validated", () => {
	const report = ops.parseClientReport({
		message: "x",
		platform: "WEB",
		screen: "BookingDetails",
		appVersion: "1.4.2+57",
		handled: false,
	});
	assert.deepEqual([report.platform, report.route, report.appVersion], ["web", "BookingDetails", "1.4.2+57"]);
	const bad = (body: unknown) =>
		assert.throws(() => ops.parseClientReport(body), ops.ClientReportError, JSON.stringify(body));
	bad(null);
	bad([]);
	bad({ platform: "web" });
	bad({ message: "x", platform: "desktop" });
	bad({ message: "x", platform: "web", appVersion: "1 2" });
	bad({ message: "x", platform: "web", email: "a@b.com" });
	bad({ message: { $gt: "" }, platform: "web" });
	bad({ message: "x", platform: "web", handled: "yes" });
	assert.equal(ops.parseClientReport({ message: "y".repeat(5000), platform: "ios" }).message.length, 2000);
});

test("observability routes: signed in, permission, rate limited, writes audited with manage", () => {
	const routes = (adminRoute.stack as any[])
		.filter((layer) => layer.route?.path?.startsWith("/observability"))
		.map((layer) => ({
			id: `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`,
			handles: layer.route.stack.map((s: any) => s.handle),
		}));
	assert.ok(routes.length >= 30, `${routes.length} observability routes`);
	for (const route of routes) {
		assert.equal(route.handles[0], verifyAdminJWT, route.id);
		const permission = route.handles[1].permission;
		assert.ok(
			route.handles.some((h: any) => limiters.includes(h)),
			`${route.id} has a limiter`,
		);
		if (route.id.startsWith("GET")) {
			assert.equal(permission, "observability.read", route.id);
		} else {
			assert.equal(permission, "observability.manage", route.id);
			const actions = auditActionsOf(route.handles[route.handles.length - 1]);
			assert.ok(
				actions?.length && actions.every((a: string) => a.startsWith("observability.")),
				`${route.id} audited`,
			);
		}
	}
	assert.ok(ROLE_PERMISSIONS.operations.includes("observability.manage"));
	assert.ok(!ROLE_PERMISSIONS.analyst.includes("observability.manage"));
	assert.ok(!ROLE_PERMISSIONS.demo.includes("observability.manage"));
});
