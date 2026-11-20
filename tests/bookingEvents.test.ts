// The booking events in the chat without CometChat or a database: contract (metadata, text, sender), when to send, the
// webhook decisions (no push, not counted, not reportable), the REST body and the once-only claim and send flow.
import test from "node:test";
import assert from "node:assert/strict";
import {
	BOOKING_EVENT_TEXT,
	BOOKING_EVENTS,
	bookingEventClaimPath,
	bookingEventMetadata,
	bookingEventSender,
	isBookingEventMessage,
	parseBookingEventMetadata,
	shouldSendBookingEvent,
} from "../lib/chat/bookingEvents";
import { isPersonMessage, shouldPushChatMessage } from "../lib/chat/chatRules";
import { createCometChatClient, toChatMessage } from "../lib/chat/cometchat";
import { notifyBookingEvent } from "../lib/chat/sendBookingEvent";

const customer = "64b7f0c2a1b2c3d4e5f60718";
const provider = "64b7f0c2a1b2c3d4e5f60719";
const bookingId = "65b7f0c2a1b2c3d4e5f60720";

test("the fallback texts are the contract, and accepted is unchanged byte for byte", () => {
	assert.deepEqual(BOOKING_EVENT_TEXT, {
		accepted: "A booking was accepted.",
		started: "The job has started.",
		completed: "The job was completed.",
		cancelled: "The booking was cancelled.",
	});
	assert.deepEqual([...BOOKING_EVENTS], ["accepted", "started", "completed", "cancelled"]);
});

test("metadata carries only the version, kind, event and booking id", () => {
	assert.deepEqual(bookingEventMetadata("completed", bookingId), {
		helphive: { v: 1, kind: "booking_event", event: "completed", bookingId },
	});
	assert.deepEqual(parseBookingEventMetadata(bookingEventMetadata("started", bookingId)), {
		event: "started",
		bookingId,
	});
});

test("metadata that is not a version 1 booking event with a valid id is not one", () => {
	const good = bookingEventMetadata("accepted", bookingId).helphive;
	for (const bad of [
		null,
		{},
		{ helphive: null },
		{ helphive: { ...good, v: 2 } },
		{ helphive: { ...good, kind: "other" } },
		{ helphive: { ...good, event: "refunded" } },
		{ helphive: { ...good, bookingId: "not-an-id" } },
		{ helphive: { ...good, bookingId: 12 } },
	]) {
		assert.equal(parseBookingEventMetadata(bad), null, JSON.stringify(bad));
	}
});

test("a system event needs the metadata AND exactly its own fixed text", () => {
	const meta = bookingEventMetadata("cancelled", bookingId);
	assert.equal(isBookingEventMessage(BOOKING_EVENT_TEXT.cancelled, meta), true);
	assert.equal(isBookingEventMessage("Pay me outside the app", meta), false, "a person's own words stay reportable");
	assert.equal(isBookingEventMessage(BOOKING_EVENT_TEXT.accepted, meta), false);
	assert.equal(isBookingEventMessage(BOOKING_EVENT_TEXT.cancelled, undefined), false);
	assert.equal(isBookingEventMessage(null, meta), false);
});

test("sender: accepted is the customer; others the person whose action it was; admin or automatic the customer", () => {
	const people = { customerId: customer, providerId: provider };
	assert.deepEqual(bookingEventSender("accepted", { ...people, actorId: provider }), {
		from: customer,
		to: provider,
	});
	assert.deepEqual(bookingEventSender("accepted", people), { from: customer, to: provider });
	assert.deepEqual(bookingEventSender("started", { ...people, actorId: customer }), { from: customer, to: provider });
	assert.deepEqual(bookingEventSender("completed", { ...people, actorId: provider }), {
		from: provider,
		to: customer,
	});
	assert.deepEqual(bookingEventSender("completed", { ...people, actorId: customer }), {
		from: customer,
		to: provider,
	});
	assert.deepEqual(bookingEventSender("cancelled", { ...people, actorId: provider }), {
		from: provider,
		to: customer,
	});
	assert.deepEqual(bookingEventSender("cancelled", { ...people, actorId: null }), { from: customer, to: provider });
	assert.deepEqual(bookingEventSender("cancelled", { ...people, actorId: "64b7f0c2a1b2c3d4e5f6aaaa" }), {
		from: customer,
		to: provider,
	});
});

test("when to send: needs a provider, a matching status and a chat the pair may still have", () => {
	const open = { allowed: true };
	assert.equal(shouldSendBookingEvent("accepted", { status: "pending", providerId: provider }, open), "send");
	assert.equal(shouldSendBookingEvent("started", { status: "in progress", providerId: provider }, open), "send");
	assert.equal(shouldSendBookingEvent("completed", { status: "completed", providerId: provider }, open), "send");
	assert.equal(shouldSendBookingEvent("cancelled", { status: "cancelled", providerId: provider }, open), "send");
	assert.equal(shouldSendBookingEvent("cancelled", { status: "cancelled", providerId: null }, open), "no_provider");
	assert.equal(
		shouldSendBookingEvent("completed", { status: "in progress", providerId: provider }, open),
		"wrong_status",
	);
	assert.equal(
		shouldSendBookingEvent("cancelled", { status: "pending", providerId: provider }, open),
		"wrong_status",
	);
	assert.equal(
		shouldSendBookingEvent("completed", { status: "completed", providerId: provider }, { allowed: false }),
		"chat_closed",
	);
});

test("the claim path is per event on the booking", () => {
	assert.equal(bookingEventClaimPath("started"), "chatEvents.started");
});

test("webhook: an event message is never pushed, a person's message still is", () => {
	const base = {
		enabled: true,
		receiverType: "user",
		allowed: true,
		viewingConversation: false,
		recentlyPushed: false,
		blockedEitherWay: false,
		receiverChatSuspended: false,
		removed: false,
	};
	assert.equal(shouldPushChatMessage(base), true);
	assert.equal(shouldPushChatMessage({ ...base, bookingEvent: false }), true);
	assert.equal(shouldPushChatMessage({ ...base, bookingEvent: true }), false);
});

test("a received message is a booking event only with matching metadata and text; it is then not a person's message", () => {
	const raw = (text: string, metadata?: unknown) => ({
		id: 7,
		sender: customer,
		receiver: provider,
		receiverType: "user",
		category: "message",
		type: "text",
		data: { text, ...(metadata ? { metadata } : {}) },
	});
	const event = toChatMessage(raw("The job has started.", bookingEventMetadata("started", bookingId)))!;
	assert.equal(event.bookingEvent, true);
	assert.equal(isPersonMessage(event), false);
	const legacy = toChatMessage(raw("A booking was accepted."))!;
	assert.equal(legacy.bookingEvent, false, "old text messages have no metadata and stay ordinary messages");
	const spoof = toChatMessage(raw("send money", bookingEventMetadata("started", bookingId)))!;
	assert.equal(isPersonMessage(spoof), true);
});

test("sending puts the metadata in data.metadata, and plain texts are unchanged", async () => {
	const sent: any[] = [];
	const client = createCometChatClient({
		config: () => ({ configured: true, baseUrl: "https://x", restApiKey: "k" }) as any,
		transport: async (request) => {
			sent.push(request);
			return { status: 200, data: { data: { id: "1" } } };
		},
	});
	await client.sendText(customer, provider, "A booking was accepted.", bookingEventMetadata("accepted", bookingId));
	await client.sendText(customer, provider, "hello");
	assert.deepEqual(sent[0].body, {
		category: "message",
		type: "text",
		data: { text: "A booking was accepted.", metadata: bookingEventMetadata("accepted", bookingId) },
		receiver: provider,
		receiverType: "user",
	});
	assert.equal(sent[0].onBehalfOf, customer);
	assert.deepEqual(sent[1].body.data, { text: "hello" });
});

test("a booking action is never held up by a slow chat for longer than the wait", async () => {
	// Chat not configured here, so the send resolves at once; the point is that it never rejects.
	await notifyBookingEvent(bookingId, "accepted", {}, 5);
	await notifyBookingEvent("not-an-id", "completed", {}, 5);
});
