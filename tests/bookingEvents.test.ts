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
	claimedBookingEvent,
	EVENT_WINDOW_AFTER_MS,
	EVENT_WINDOW_BEFORE_MS,
	verifyBookingEventAuthorship,
	parseBookingEventMetadata,
	shouldSendBookingEvent,
} from "../lib/chat/bookingEvents";
import { shouldPushChatMessage } from "../lib/chat/chatRules";
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

test("a claimed event needs the metadata AND exactly its own fixed sentence", () => {
	const meta = bookingEventMetadata("cancelled", bookingId);
	assert.deepEqual(claimedBookingEvent(BOOKING_EVENT_TEXT.cancelled, meta), { event: "cancelled", bookingId });
	assert.equal(claimedBookingEvent("Pay me outside the app", meta), null, "right metadata, other words");
	assert.equal(claimedBookingEvent(BOOKING_EVENT_TEXT.accepted, meta), null, "another event's sentence");
	assert.equal(claimedBookingEvent(BOOKING_EVENT_TEXT.cancelled, undefined), null);
	assert.equal(claimedBookingEvent(null, meta), null);
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

test("a received message only claims to be an event with matching metadata and text (a claim, not proof)", () => {
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
	assert.deepEqual(event.bookingEvent, { event: "started", bookingId });
	assert.equal(
		toChatMessage(raw("A booking was accepted."))!.bookingEvent,
		null,
		"the legacy sentence has no metadata",
	);
	assert.equal(toChatMessage(raw("send money", bookingEventMetadata("started", bookingId)))!.bookingEvent, null);
});

// Authorship: what proves the server sent it is the claim on the booking, never the message.
const T0 = Date.parse("2026-11-20T10:00:00Z");
const claimFor = (event: "accepted" | "started" | "completed" | "cancelled", from = customer, at = T0) => ({
	[event]: { at: new Date(at), from },
});
const booking = (chatEvents: any, over: any = {}) => ({
	_id: bookingId,
	userId: customer,
	providerId: provider,
	chatEvents,
	...over,
});
const sentMsg = (event: "accepted" | "started" | "completed" | "cancelled", over: any = {}) => ({
	sender: customer,
	receiver: provider,
	sentAtMs: T0 + 1500,
	claim: { event, bookingId },
	...over,
});
const verdict = (message: any, b: any) => verifyBookingEventAuthorship({ message, booking: b });

test("authorship: a genuine event (claimed on the booking, right pair, sender and time) is genuine", () => {
	assert.equal(verdict(sentMsg("accepted"), booking(claimFor("accepted"))), "genuine");
	assert.equal(
		verdict(
			sentMsg("completed", { sender: provider, receiver: customer }),
			booking(claimFor("completed", provider)),
		),
		"genuine",
	);
	assert.equal(
		verdict(sentMsg("started", { sentAtMs: T0 - EVENT_WINDOW_BEFORE_MS }), booking(claimFor("started"))),
		"genuine",
	);
	assert.equal(
		verdict(sentMsg("started", { sentAtMs: T0 + EVENT_WINDOW_AFTER_MS }), booking(claimFor("started"))),
		"genuine",
	);
});

test("authorship: a forged event for a booking of another pair is not genuine", () => {
	const other = "64b7f0c2a1b2c3d4e5f6aaaa";
	assert.equal(verdict(sentMsg("accepted", { sender: other }), booking(claimFor("accepted"))), "other_pair");
	assert.equal(verdict(sentMsg("accepted", { receiver: other }), booking(claimFor("accepted"))), "other_pair");
	assert.equal(verdict(sentMsg("accepted"), booking(claimFor("accepted"), { providerId: other })), "other_pair");
	assert.equal(verdict(sentMsg("accepted"), null), "other_pair", "no such booking");
	assert.equal(
		verdict(sentMsg("accepted"), booking(claimFor("accepted"), { _id: "65b7f0c2a1b2c3d4e5f6bbbb" })),
		"other_pair",
	);
});

test("authorship: a forged event the server has not claimed yet is not genuine", () => {
	assert.equal(verdict(sentMsg("completed"), booking(claimFor("accepted"))), "not_claimed");
	assert.equal(verdict(sentMsg("completed"), booking(undefined)), "not_claimed");
	assert.equal(verdict(sentMsg("completed"), booking({ completed: { at: null, from: customer } })), "not_claimed");
});

test("authorship: a replay of a genuine event long after the claim is not genuine", () => {
	assert.equal(
		verdict(sentMsg("accepted", { sentAtMs: T0 + EVENT_WINDOW_AFTER_MS + 1000 }), booking(claimFor("accepted"))),
		"outside_window",
	);
	assert.equal(
		verdict(sentMsg("accepted", { sentAtMs: T0 - EVENT_WINDOW_BEFORE_MS - 1000 }), booking(claimFor("accepted"))),
		"outside_window",
	);
	assert.equal(verdict(sentMsg("accepted", { sentAtMs: null }), booking(claimFor("accepted"))), "outside_window");
});

test("authorship: the sender must be the one the claim was made for (accepted is always the customer)", () => {
	// Provider typing the accepted event: the sender rule says the customer.
	assert.equal(
		verdict(sentMsg("accepted", { sender: provider, receiver: customer }), booking(claimFor("accepted", provider))),
		"wrong_sender",
	);
	// A completed event claimed for the provider cannot be sent as the customer.
	assert.equal(verdict(sentMsg("completed"), booking(claimFor("completed", provider))), "wrong_sender");
});

test("authorship: right metadata with a different sentence, or the legacy sentence typed by a person, is never an event", () => {
	const raw = (text: string, metadata?: unknown) =>
		toChatMessage({
			id: 9,
			sender: customer,
			receiver: provider,
			receiverType: "user",
			category: "message",
			type: "text",
			data: { text, ...(metadata ? { metadata } : {}) },
		})!;
	const different = raw("The job was completed, pay me directly.", bookingEventMetadata("completed", bookingId));
	assert.equal(
		verdict({ ...sentMsg("completed"), claim: different.bookingEvent }, booking(claimFor("completed"))),
		"not_an_event",
	);
	const legacy = raw("A booking was accepted.");
	assert.equal(
		verdict({ ...sentMsg("accepted"), claim: legacy.bookingEvent }, booking(claimFor("accepted"))),
		"not_an_event",
	);
	// The same words with the metadata AND a claim on the booking, but at another time, are still a person's message.
	assert.equal(
		verdict(sentMsg("accepted", { sentAtMs: T0 + 3_600_000 }), booking(claimFor("accepted"))),
		"outside_window",
	);
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
