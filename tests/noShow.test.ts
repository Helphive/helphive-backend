// The no-show rule (an accepted booking nobody started is cancelled and refunded after its shift): the pure decisions,
// and the Cloud Task handler with the database, Stripe, notifications, chat and Cloud Tasks replaced.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

// Never reach a database or a service from here.
delete process.env.DATABASE_URI;
mongoose.set("bufferCommands", false);
process.env.STRIPE_SECRET_KEY = "sk_test_unit_only";

/* eslint-disable @typescript-eslint/no-require-imports */
const noShow = require("../lib/noShow") as typeof import("../lib/noShow");
const settings = require("../lib/settings") as typeof import("../lib/settings");
const { EVENT_CATALOGUE } = require("../lib/eventCatalogue") as typeof import("../lib/eventCatalogue");
const { deriveBookingEvents } = require("../lib/backfill") as typeof import("../lib/backfill");
const { taskReplayEligibility } = require("../lib/observability/replay");
const { taskOutcomeFor } = require("../lib/webhookRecorder");
const { getBookingDisplayStatus } = require("../controllers/user-controllers/utils/booking.utils");
const { setEventWriter } = require("../lib/events");
const { setLogSink } = require("../lib/logger");
const BookingModel = require("../dal/models/booking.model").default;
const userUtils = require("../controllers/user-controllers/utils/user.utils");
const authUtils = require("../controllers/user-controllers/utils/auth.utils");
const chatEvents = require("../lib/chat/sendBookingEvent");
const chatSync = require("../lib/chat/chatSync");
const { handleGoogleCloudTasksBookingNoShow } = require("../controllers/webhook-controllers/cloudtasks.controller");
/* eslint-enable @typescript-eslint/no-require-imports */

setLogSink(() => undefined);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const {
	NO_SHOW_CANCELLATION_REASON,
	NO_SHOW_EARLY_TOLERANCE_MS,
	MAX_TASK_DELAY_MS,
	decideNoShow,
	noShowCheckAt,
	noShowDueAt,
	noShowTransitionFilter,
} = noShow;

const start = new Date("2026-11-21T09:00:00Z");
const accepted = (over: Record<string, unknown> = {}) => ({
	status: "pending",
	providerId: "64b7f0c2a1b2c3d4e5f60719",
	userApprovalRequested: false,
	startDate: start,
	hours: 6,
	...over,
});

// --- The rule ----------------------------------------------------------------------------------------------------

test("due time: the scheduled end plus the grace period", () => {
	assert.equal(noShowDueAt({ startDate: start, hours: 6 }, 60)!.toISOString(), "2026-11-21T16:00:00.000Z");
	assert.equal(noShowDueAt({ startDate: start, hours: 1 }, 0)!.toISOString(), "2026-11-21T10:00:00.000Z");
	assert.equal(
		noShowDueAt({ startDate: start.toISOString(), hours: 2.5 }, 30)!.toISOString(),
		"2026-11-21T12:00:00.000Z",
	);
	for (const bad of [
		{ startDate: null, hours: 6 },
		{ startDate: "not a date", hours: 6 },
		{ startDate: start, hours: 0 },
		{ startDate: start, hours: null },
		{ startDate: start, hours: Number.NaN },
	]) {
		assert.equal(noShowDueAt(bad as any, 60), null);
	}
	assert.equal(noShowDueAt({ startDate: start, hours: 6 }, -1), null);
});

test("default grace is one hour and is a setting an admin can change", () => {
	assert.equal(settings.DEFAULT_SETTINGS["bookings.noShowGraceMinutes"], 60);
	assert.equal(settings.validateSettingValue("bookings.noShowGraceMinutes", 0).ok, true);
	assert.equal(settings.validateSettingValue("bookings.noShowGraceMinutes", 7 * 24 * 60).ok, true);
	assert.equal(settings.validateSettingValue("bookings.noShowGraceMinutes", -5).ok, false);
	assert.equal(settings.validateSettingValue("bookings.noShowGraceMinutes", 7 * 24 * 60 + 1).ok, false);
	assert.equal(settings.validateSettingValue("bookings.noShowGraceMinutes", 12.5).ok, false);
});

test("decision: cancel only an accepted booking with no start request, once the shift and the grace are over", () => {
	const due = new Date("2026-11-21T16:00:00Z");
	const at = (offset: number) => new Date(due.getTime() + offset);
	assert.equal(decideNoShow(accepted(), at(0), 60), "cancel");
	assert.equal(decideNoShow(accepted(), at(3 * DAY), 60), "cancel");
	assert.equal(
		decideNoShow(accepted(), at(-NO_SHOW_EARLY_TOLERANCE_MS), 60),
		"cancel",
		"a task a moment early is due",
	);
	assert.equal(decideNoShow(accepted(), at(-NO_SHOW_EARLY_TOLERANCE_MS - 1), 60), "not_due");
	assert.equal(decideNoShow(accepted(), new Date("2026-11-21T12:00:00Z"), 60), "not_due", "mid-shift");
	assert.equal(decideNoShow(accepted(), new Date("2026-11-21T15:30:00Z"), 60), "not_due", "shift over, in the grace");
	assert.equal(decideNoShow(accepted(), at(0), 120), "not_due", "a raised grace moves the due time");
});

test("decision: never a booking somebody started, asked to start, completed, cancelled or released", () => {
	const late = new Date("2026-11-25T00:00:00Z");
	assert.equal(decideNoShow(accepted({ userApprovalRequested: true }), late, 60), "not_applicable");
	assert.equal(decideNoShow(accepted({ status: "in progress" }), late, 60), "not_applicable");
	assert.equal(decideNoShow(accepted({ status: "completed" }), late, 60), "not_applicable");
	assert.equal(
		decideNoShow(accepted({ providerId: null }), late, 60),
		"not_applicable",
		"released or never accepted",
	);
	assert.equal(decideNoShow(accepted({ status: "cancelled" }), late, 60), "not_applicable");
	assert.equal(
		decideNoShow(accepted({ status: "cancelled", cancellationReason: "Customer asked by phone" }), late, 60),
		"not_applicable",
	);
	assert.equal(decideNoShow(accepted({ hours: 0 }), late, 60), "not_applicable", "no valid shift, no guess");
});

test("decision: a booking this rule already cancelled only has its refund checked", () => {
	const cancelled = accepted({ status: "cancelled", cancellationReason: NO_SHOW_CANCELLATION_REASON });
	assert.equal(decideNoShow(cancelled, new Date("2026-11-25T00:00:00Z"), 60), "refund_only");
});

test("the check runs at the due time, or as late as Cloud Tasks allows when the shift is far ahead", () => {
	const now = new Date("2026-11-20T00:00:00Z");
	const soon = new Date("2026-11-21T16:00:00Z");
	assert.equal(noShowCheckAt(soon, now).getTime(), soon.getTime());
	const far = new Date(now.getTime() + 45 * DAY);
	assert.equal(noShowCheckAt(far, now).getTime(), now.getTime() + MAX_TASK_DELAY_MS);
	assert.ok(MAX_TASK_DELAY_MS < 30 * DAY, "inside the Cloud Tasks limit of 30 days");
	const overdue = new Date(now.getTime() - 40 * DAY);
	assert.equal(noShowCheckAt(overdue, now).getTime(), overdue.getTime(), "an overdue check runs at once");
});

test("the one transition: only while still accepted by that provider with no start request", () => {
	assert.deepEqual(noShowTransitionFilter("b1", "p1"), {
		_id: "b1",
		status: "pending",
		providerId: "p1",
		userApprovalRequested: { $ne: true },
	});
});

// --- How the rest of the server sees it --------------------------------------------------------------------------

test("a booking cancelled by the rule reads as cancelled, with a reason fit to show both people", () => {
	const booking = accepted({
		status: "cancelled",
		cancelledAt: new Date("2026-11-21T16:00:05Z"),
		cancellationReason: NO_SHOW_CANCELLATION_REASON,
	});
	assert.equal(getBookingDisplayStatus(booking), "cancelled");
	assert.equal(NO_SHOW_CANCELLATION_REASON, "The job was not started before the shift ended.");
});

test("events: booking.no_show is in the catalogue, and the backfill derives it instead of a person's cancellation", () => {
	assert.ok(EVENT_CATALOGUE["booking.no_show"]);
	assert.deepEqual(EVENT_CATALOGUE["booking.no_show"].subjects, ["userId", "providerId", "bookingId"]);
	const id = new mongoose.Types.ObjectId();
	const events = deriveBookingEvents({
		_id: id,
		userId: new mongoose.Types.ObjectId(),
		providerId: new mongoose.Types.ObjectId(),
		service: { id: 1 },
		rate: 30,
		hours: 6,
		status: "cancelled",
		createdAt: new Date("2026-11-19T10:00:00Z"),
		acceptedAt: new Date("2026-11-19T11:00:00Z"),
		startDate: start,
		cancelledAt: new Date("2026-11-21T16:00:05Z"),
		cancellationReason: NO_SHOW_CANCELLATION_REASON,
	}) as any[];
	const types = events.map((event) => event.type);
	assert.deepEqual(types, ["booking.created", "booking.accepted", "booking.no_show"]);
	const event = events[2];
	assert.equal(event.actor.type, "system");
	assert.equal(event.properties.sinceEndMs, HOUR + 5000);
});

test("task runs: 'not due' and 'not pending' answers are skipped runs, and a failed run can be replayed", () => {
	assert.equal(taskOutcomeFor(200, "Booking is not due yet; the check was scheduled again"), "skipped");
	assert.equal(taskOutcomeFor(200, "Booking is not pending with a provider and no start request"), "skipped");
	assert.equal(taskOutcomeFor(200, "Booking is not pending any more"), "skipped");
	assert.equal(
		taskOutcomeFor(200, "Booking already cancelled (not started) and its refund already handled"),
		"skipped",
	);
	assert.equal(taskOutcomeFor(200, "Booking cancelled (not started) and refund requested"), "processed");
	assert.equal(taskOutcomeFor(200, "Booking cancelled (not started); nothing to refund"), "processed");
	assert.equal(
		taskOutcomeFor(200, "Booking was cancelled earlier (not started); the refund was requested now"),
		"processed",
	);
	assert.equal(taskOutcomeFor(500, "Internal server error"), "failed");
	const run = { task: "booking-no-show", outcome: "failed", bookingId: "65f0a1b2c3d4e5f6a7b8c9d0" };
	assert.equal(taskReplayEligibility(run).eligible, true);
});

// --- The task handler --------------------------------------------------------------------------------------------

interface World {
	booking: any;
	/** What the conditional update finds: null when somebody changed the booking in between. */
	transitionWins: boolean;
	refund: () => Promise<{ outcome: string }>;
	calls: string[];
	updates: { filter: any; update: any }[];
	scheduled: { bookingId: string; at: Date }[];
	events: any[];
}

const bookingId = "65b7f0c2a1b2c3d4e5f60720";
const customerId = new mongoose.Types.ObjectId("64b7f0c2a1b2c3d4e5f60718");
const providerId = new mongoose.Types.ObjectId("64b7f0c2a1b2c3d4e5f60719");

/** Replaces everything the handler touches; returns the world to inspect and a restore function. */
const stage = (over: Record<string, unknown>, options: Partial<Pick<World, "transitionWins" | "refund">> = {}) => {
	const world: World = {
		booking: {
			_id: new mongoose.Types.ObjectId(bookingId),
			userId: customerId,
			providerId,
			status: "pending",
			userApprovalRequested: false,
			startDate: new Date(Date.now() - 10 * HOUR),
			hours: 2,
			service: { id: 1, name: "Public Area Attendant" },
			...over,
		},
		transitionWins: options.transitionWins ?? true,
		refund: options.refund ?? (async () => ({ outcome: "refund_requested" })),
		calls: [],
		updates: [],
		scheduled: [],
		events: [],
	};
	const saved = {
		findById: BookingModel.findById,
		findOneAndUpdate: BookingModel.findOneAndUpdate,
		trigger: userUtils.createGoogleCloudTaskBookingNoShowTrigger,
		notify: userUtils.sendBookingNoShowNotification,
		refund: authUtils.refundPaymentIfPaid,
		chatEvent: chatEvents.sendBookingEvent,
		chatSync: chatSync.syncBookingChat,
	};
	BookingModel.findById = () => ({ exec: async () => world.booking });
	BookingModel.findOneAndUpdate = (filter: any, update: any) => {
		world.updates.push({ filter, update });
		return {
			exec: async () => {
				if (!world.transitionWins) return null;
				world.calls.push("cancelled");
				return { ...world.booking, ...update.$set };
			},
		};
	};
	userUtils.createGoogleCloudTaskBookingNoShowTrigger = async (id: string, at: Date) => {
		world.scheduled.push({ bookingId: id, at });
	};
	userUtils.sendBookingNoShowNotification = async () => void world.calls.push("notified");
	authUtils.refundPaymentIfPaid = async () => {
		world.calls.push("refund");
		return world.refund();
	};
	chatEvents.sendBookingEvent = async (_id: unknown, event: string) => {
		world.calls.push(`chat:${event}`);
		return "sent";
	};
	chatSync.syncBookingChat = async () => {
		world.calls.push("chat-synced");
		return null;
	};
	settings.setSettingsDependencies({ loader: async () => ({}) });
	setEventWriter(async (doc: any) => void world.events.push(doc));
	const restore = () => {
		BookingModel.findById = saved.findById;
		BookingModel.findOneAndUpdate = saved.findOneAndUpdate;
		userUtils.createGoogleCloudTaskBookingNoShowTrigger = saved.trigger;
		userUtils.sendBookingNoShowNotification = saved.notify;
		authUtils.refundPaymentIfPaid = saved.refund;
		chatEvents.sendBookingEvent = saved.chatEvent;
		chatSync.syncBookingChat = saved.chatSync;
		setEventWriter(async () => undefined);
	};
	return { world, restore };
};

const run = async (id: unknown = bookingId) => {
	const res: any = { statusCode: 200 };
	res.status = (code: number) => ((res.statusCode = code), res);
	res.json = (body: unknown) => ((res.body = body), res);
	await handleGoogleCloudTasksBookingNoShow({ body: { bookingId: id }, headers: {} } as any, res);
	// Events are written on the next turn of the event loop (emitEvent never holds a request up).
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	return res as { statusCode: number; body: { message: string } };
};

test("handler: a booking nobody started is cancelled once, both are told, the chat gets its card, then the refund", async () => {
	const { world, restore } = stage({});
	try {
		const res = await run();
		assert.equal(res.statusCode, 200);
		assert.equal(res.body.message, "Booking cancelled (not started) and refund requested");
		assert.deepEqual(world.calls, ["cancelled", "notified", "chat:cancelled", "chat-synced", "refund"]);
		assert.equal(world.updates.length, 1);
		assert.deepEqual(world.updates[0].filter, noShowTransitionFilter(world.booking._id, providerId));
		const set = world.updates[0].update.$set;
		assert.equal(set.status, "cancelled");
		assert.equal(set.cancellationReason, NO_SHOW_CANCELLATION_REASON);
		assert.ok(set.cancelledAt instanceof Date);
		assert.equal("cancelledBy" in set, false, "nobody cancelled it, so it counts against nobody");
		assert.equal(world.scheduled.length, 0);
		const event = world.events.find((doc) => doc.type === "booking.no_show");
		assert.ok(event, "booking.no_show recorded");
		assert.equal(event.actor.type, "system");
		assert.equal(event.properties.graceMinutes, 60);
		assert.ok(event.properties.sinceEndMs > 7 * HOUR);
		assert.equal(
			world.events.some((doc) => doc.type === "booking.cancelled"),
			false,
			"not a person's cancellation",
		);
	} finally {
		restore();
	}
});

test("handler: not due yet (shift ahead) changes nothing and schedules itself again for the due time", async () => {
	const startDate = new Date(Date.now() + 2 * HOUR);
	const { world, restore } = stage({ startDate, hours: 3 });
	try {
		const res = await run();
		assert.equal(res.statusCode, 200);
		assert.match(res.body.message, /not due yet/);
		assert.deepEqual(world.calls, []);
		assert.equal(world.updates.length, 0);
		assert.equal(world.scheduled.length, 1);
		assert.equal(world.scheduled[0].bookingId, bookingId);
		assert.equal(world.scheduled[0].at.getTime(), startDate.getTime() + 3 * HOUR + 60 * MIN);
	} finally {
		restore();
	}
});

test("handler: a start request, a started job, a completed one and a released one are left alone", async () => {
	for (const over of [
		{ userApprovalRequested: true },
		{ status: "in progress" },
		{ status: "completed" },
		{ providerId: null },
		{ status: "cancelled", cancellationReason: "Customer asked by phone" },
	]) {
		const { world, restore } = stage(over);
		try {
			const res = await run();
			assert.equal(res.statusCode, 200);
			assert.match(res.body.message, /not pending/);
			assert.deepEqual(world.calls, [], JSON.stringify(over));
			assert.equal(world.updates.length, 0);
			assert.equal(world.scheduled.length, 0);
			assert.equal(world.events.length, 0);
		} finally {
			restore();
		}
	}
});

test("handler: losing the race (a start request arrived in between) cancels nothing and refunds nothing", async () => {
	const { world, restore } = stage({}, { transitionWins: false });
	try {
		const res = await run();
		assert.equal(res.statusCode, 200);
		assert.match(res.body.message, /not pending any more/);
		assert.deepEqual(world.calls, []);
		assert.equal(world.events.length, 0);
	} finally {
		restore();
	}
});

test("handler: a refund that fails answers 500, and the retry only requests the refund", async () => {
	const failing = stage({}, { refund: async () => Promise.reject(new Error("stripe is down")) });
	try {
		const res = await run();
		assert.equal(res.statusCode, 500, "so Cloud Tasks runs it again");
		assert.deepEqual(failing.world.calls, ["cancelled", "notified", "chat:cancelled", "chat-synced", "refund"]);
	} finally {
		failing.restore();
	}
	const retry = stage({ status: "cancelled", cancellationReason: NO_SHOW_CANCELLATION_REASON });
	try {
		const res = await run();
		assert.equal(res.statusCode, 200);
		assert.match(res.body.message, /refund was requested now/);
		assert.deepEqual(retry.world.calls, ["refund"], "no second cancellation, notification or chat card");
		assert.equal(retry.world.updates.length, 0);
	} finally {
		retry.restore();
	}
	const again = stage(
		{ status: "cancelled", cancellationReason: NO_SHOW_CANCELLATION_REASON },
		{ refund: async () => ({ outcome: "already_refunded" }) },
	);
	try {
		const res = await run();
		assert.match(res.body.message, /already/);
		assert.deepEqual(again.world.calls, ["refund"]);
	} finally {
		again.restore();
	}
});

test("handler: a missing or malformed booking id is answered without touching anything", async () => {
	const { world, restore } = stage({});
	try {
		for (const id of [null, "", "nope", 12345, { $ne: null }]) {
			const res = await run(id);
			assert.equal(res.statusCode, 200);
			assert.match(res.body.message, /required/);
		}
		world.booking = null;
		const res = await run();
		assert.match(res.body.message, /not found/);
		assert.deepEqual(world.calls, []);
	} finally {
		restore();
	}
});
