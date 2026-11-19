// Run with: npx ts-node tests/events.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { EventSampler, buildEvent, emitEvent, setEventWriter } from "../lib/events";
import { EVENT_CATALOGUE, isKnownEventType } from "../lib/eventCatalogue";
import { setLogSink } from "../lib/logger";
import {
	before,
	countByType,
	deriveApplicationEvents,
	deriveBookingEvents,
	deriveEarningEvents,
	derivePaymentEvents,
	derivePayoutEvents,
	deriveUserEvents,
} from "../lib/backfill";
import { EXPIRED_CANCELLATION_REASON } from "../controllers/user-controllers/utils/booking.utils";

const oid = () => new mongoose.Types.ObjectId();
const context = {
	requestId: "req-abcdefgh",
	ip: "203.0.113.7",
	userAgent: "HelpHive/2.0",
	platform: "ios",
	appVersion: "2.0.1",
	deviceId: "device-1234",
	actor: { type: "user" as const, id: "64b7f0c2a1b2c3d4e5f60718" },
};

test("buildEvent: type, time, actor, subject ids as ObjectIds (absent when not given), redacted properties, context", () => {
	const bookingId = oid();
	const at = new Date("2026-11-19T10:00:00Z");
	const doc = buildEvent(
		{
			type: "booking.cancelled",
			at,
			subjects: { bookingId, userId: String(context.actor.id), providerId: null, paymentId: "not-an-id" },
			properties: { by: "customer", reason: "Email me at jane@example.com", token: "secret" },
		},
		context,
	) as any;
	assert.equal(doc.type, "booking.cancelled");
	assert.equal(doc.at, at);
	assert.deepEqual(
		doc.actor,
		{ type: "user", id: "64b7f0c2a1b2c3d4e5f60718" },
		"actor defaults to the signed-in one",
	);
	assert.ok(doc.bookingId.equals(bookingId));
	assert.ok(doc.userId instanceof mongoose.Types.ObjectId);
	assert.equal("providerId" in doc, false, "null subjects are left out (partial indexes)");
	assert.equal("paymentId" in doc, false, "invalid ids are left out");
	assert.deepEqual(doc.properties, { by: "customer", reason: "Email me at j***@example.com", token: "[redacted]" });
	assert.deepEqual(doc.context, {
		ip: "203.0.113.7",
		userAgent: "HelpHive/2.0",
		platform: "ios",
		appVersion: "2.0.1",
		deviceId: "device-1234",
		requestId: "req-abcdefgh",
	});
	assert.equal(doc.source, "live");
	assert.equal(
		(buildEvent({ type: "booking.expired", actor: { type: "system" } }, undefined) as any).actor.type,
		"system",
	);
});

test("emitEvent returns at once, writes later, and swallows write errors", async () => {
	const writes: any[] = [];
	let fail = false;
	const quiet = setLogSink(() => undefined);
	setEventWriter(async (doc) => {
		if (fail) throw new Error("database down");
		writes.push(doc);
	});
	emitEvent({ type: "user.signed_up", subjects: { userId: oid() }, properties: { role: "customer" } });
	assert.equal(writes.length, 0, "nothing written synchronously");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(writes.length, 1);
	fail = true;
	assert.doesNotThrow(() => emitEvent({ type: "user.signed_up" }));
	await new Promise((resolve) => setImmediate(resolve));
	setLogSink(quiet);
});

test("the rate-limit sampler records the first per key per window and caps the rate, counting what it drops", () => {
	let now = 0;
	const sampler = new EventSampler(10 * 60_000, 3, () => now);
	assert.deepEqual(sampler.take("login|ip:1"), { suppressed: 0 });
	assert.equal(sampler.take("login|ip:1"), null, "same key within the window");
	assert.deepEqual(sampler.take("login|ip:2"), { suppressed: 1 });
	assert.deepEqual(sampler.take("login|ip:3"), { suppressed: 0 });
	assert.equal(sampler.take("login|ip:4"), null, "minute cap reached");
	// An attack from 100,000 addresses in one minute records at most the cap.
	let recorded = 0;
	for (let i = 0; i < 100_000; i++) if (sampler.take(`login|ip:x${i}`)) recorded++;
	assert.equal(recorded, 0);
	now += 60_000;
	assert.deepEqual(sampler.take("login|ip:5"), { suppressed: 100_001 });
	now += 10 * 60_000;
	assert.ok(sampler.take("login|ip:1"), "window over");
});

test("every event type emitted in the code is in the catalogue, and every catalogue entry is emitted somewhere", () => {
	const root = path.resolve(__dirname, "..");
	const used = new Set<string>();
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (["node_modules", "dist", ".git", "tests"].includes(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(entry.name) && !full.endsWith("eventCatalogue.ts")) {
				const text = fs.readFileSync(full, "utf8");
				// The `type:` line of each emitEvent({ ... }) call, and the first argument of backfill's derived(...).
				for (const call of text.matchAll(/emitEvent\(\s*\{[\s\S]{0,200}?\btype:([^\n]*)/g)) {
					for (const literal of call[1].matchAll(/"([a-z_]+\.[a-z_.]+)"/g)) used.add(literal[1]);
				}
				for (const call of text.matchAll(/derived\("([a-z_]+\.[a-z_.]+)"/g)) used.add(call[1]);
			}
		}
	};
	walk(root);
	for (const type of used) assert.ok(isKnownEventType(type), `${type} is not in EVENT_CATALOGUE`);
	for (const type of Object.keys(EVENT_CATALOGUE))
		assert.ok(used.has(type), `${type} is catalogued but never emitted`);
});

// --- Backfill derivation ---------------------------------------------------------------------------------------

const userId = oid();
const providerId = oid();
const created = new Date("2026-03-01T09:00:00Z");
const startDate = new Date("2026-03-02T09:00:00Z");

test("backfill: users and applications, with deterministic keys", () => {
	const customer = { _id: userId, roles: { User: true, Provider: false }, createdAt: created };
	const [signedUp] = deriveUserEvents(customer) as any[];
	assert.equal(signedUp.type, "user.signed_up");
	assert.equal(signedUp.key, `backfill:user.signed_up:${userId}`);
	assert.equal(signedUp.source, "backfill");
	assert.deepEqual(signedUp.properties, { role: "customer" });
	assert.deepEqual(deriveUserEvents({ _id: oid(), roles: {} }), [], "no timestamp, no event");

	const applicationId = oid();
	const reviewedBy = oid();
	const application = {
		_id: applicationId,
		status: "rejected",
		rejectReason: "Blurry",
		createdAt: created,
		updatedAt: new Date("2026-03-05T00:00:00Z"),
		reviewedAt: new Date("2026-03-04T00:00:00Z"),
		reviewedBy,
	};
	const events = deriveApplicationEvents(
		application,
		new Map([[String(applicationId), String(providerId)]]),
	) as any[];
	assert.deepEqual(
		events.map((e) => e.type),
		["provider.application_submitted", "provider.application_reviewed"],
	);
	assert.ok(events[1].providerId.equals(providerId));
	assert.equal(events[1].at.toISOString(), "2026-03-04T00:00:00.000Z", "reviewedAt preferred over updatedAt");
	assert.equal(events[1].properties.decision, "rejected");
	assert.equal(events[1].properties.waitedMs, 3 * 24 * 3600 * 1000 - 9 * 3600 * 1000);
	assert.deepEqual(events[1].actor, { type: "admin", id: String(reviewedBy) });
	const legacy = deriveApplicationEvents(
		{ ...application, reviewedAt: undefined, reviewedBy: undefined },
		new Map(),
	) as any[];
	assert.equal(legacy[1].properties.approximateTime, true);
	assert.equal(deriveApplicationEvents({ ...application, status: "pending" }, new Map()).length, 1);
});

test("backfill: a completed booking's whole lifecycle, and cancellation versus expiry", () => {
	const bookingId = oid();
	const booking = {
		_id: bookingId,
		userId,
		providerId,
		status: "completed",
		service: { id: 2 },
		rate: 20,
		hours: 4,
		startDate,
		createdAt: created,
		acceptedAt: new Date("2026-03-01T10:00:00Z"),
		startRequestedAt: new Date("2026-03-02T08:55:00Z"),
		startedAt: new Date("2026-03-02T09:05:00Z"),
		completedAt: new Date("2026-03-02T13:05:00Z"),
		completedBy: providerId,
	};
	const events = deriveBookingEvents(booking) as any[];
	assert.deepEqual(
		events.map((e) => e.type),
		[
			"booking.created",
			"booking.accepted",
			"booking.start_requested",
			"booking.start_approved",
			"booking.started",
			"booking.completed",
		],
	);
	assert.equal(events[0].properties.amount, 80);
	assert.equal(events[1].properties.timeToAcceptMs, 3600 * 1000);
	assert.equal(events[2].properties.offsetFromStartMs, -5 * 60 * 1000);
	assert.equal(events[3].properties.approvalWaitMs, 10 * 60 * 1000);
	assert.equal(events[5].properties.by, "provider");
	assert.equal(events[5].properties.durationMs, 4 * 3600 * 1000);
	assert.equal(new Set(events.map((e) => e.key)).size, events.length, "keys are unique per type");

	// Accepted before acceptedAt existed: no accepted event rather than a guessed time.
	const legacy = deriveBookingEvents({ ...booking, acceptedAt: null, startRequestedAt: null }) as any[];
	assert.equal(
		legacy.some((e) => e.type === "booking.accepted"),
		false,
	);

	const cancelled = deriveBookingEvents({
		_id: oid(),
		userId,
		providerId: null,
		status: "cancelled",
		startDate,
		createdAt: created,
		cancelledAt: new Date("2026-03-01T12:00:00Z"),
		cancelledBy: userId,
	}) as any[];
	assert.deepEqual(
		cancelled.map((e) => e.type),
		["booking.created", "booking.cancelled"],
	);
	assert.equal(cancelled[1].properties.by, "customer");

	const expired = deriveBookingEvents({
		_id: oid(),
		userId,
		providerId: null,
		status: "cancelled",
		startDate,
		createdAt: created,
		cancelledAt: startDate,
		cancelledBy: userId,
		cancellationReason: EXPIRED_CANCELLATION_REASON,
	}) as any[];
	assert.deepEqual(
		expired.map((e) => e.type),
		["booking.created", "booking.expired"],
	);
});

test("backfill: payments, refunds, earnings and payouts", () => {
	const bookingId = oid();
	const payment = {
		_id: oid(),
		bookingId,
		amount: 80,
		status: "completed",
		updatedAt: new Date("2026-03-01T09:01:00Z"),
		refundId: "re_1",
		refundStatus: "succeeded",
		refundAmount: 80,
		refundCreated: new Date("2026-03-01T12:00:00Z"),
		clientSecret: "pi_secret_should_not_appear",
	};
	const paymentEvents = derivePaymentEvents(payment, userId) as any[];
	assert.deepEqual(
		paymentEvents.map((e) => e.type),
		["payment.succeeded", "booking.paid", "refund.created", "refund.succeeded"],
	);
	assert.equal(paymentEvents[0].properties.approximateTime, true, "no paidAt: updatedAt, flagged");
	assert.ok(paymentEvents[0].userId.equals(userId));
	assert.equal(JSON.stringify(paymentEvents).includes("pi_secret"), false);
	assert.equal(derivePaymentEvents({ ...payment, paidAt: new Date(), refundId: undefined }).length, 2);
	assert.equal(derivePaymentEvents({ ...payment, status: "pending", refundId: undefined }).length, 0);

	const earning = {
		_id: oid(),
		bookingId,
		amount: 76,
		status: "completed",
		date: created,
		completionDate: new Date("2026-03-01T09:00:30Z"),
	};
	const earningEvents = deriveEarningEvents(earning, providerId) as any[];
	assert.deepEqual(
		earningEvents.map((e) => e.type),
		["earning.created", "earning.released"],
	);
	assert.equal(earningEvents[1].properties.waitedMs, 30_000);
	assert.ok(earningEvents[0].providerId.equals(providerId));

	const payout = {
		_id: oid(),
		userId: providerId,
		amount: 50,
		status: "failed",
		createdAt: created,
		updatedAt: startDate,
	};
	const payoutEvents = derivePayoutEvents(payout) as any[];
	assert.deepEqual(
		payoutEvents.map((e) => e.type),
		["payout.requested", "payout.failed"],
	);
	assert.equal(payoutEvents[1].properties.status, "failed");

	const all = [...paymentEvents, ...earningEvents, ...payoutEvents];
	// Before 10:00: payment.succeeded, booking.paid, refund.succeeded (updatedAt 09:01), earning.created and
	// earning.released, payout.requested.
	assert.equal(before(all, new Date("2026-03-01T10:00:00Z")).length, 6, "cut-off keeps only earlier events");
	assert.equal(countByType(all).get("payout.failed"), 1);
	// Same input, same keys: re-running the backfill writes nothing new.
	assert.deepEqual(
		(derivePayoutEvents(payout) as any[]).map((e) => e.key),
		payoutEvents.map((e) => e.key),
	);
});
