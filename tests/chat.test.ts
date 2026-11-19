// Run with: npx ts-node tests/chat.test.ts
// The chat rules without CometChat or a database: who may talk to whom across the booking lifecycle and the grace
// period, the demo accounts, chat sessions, webhook authentication, attachments, reports and blocks, push decisions
// and content, the CometChat REST calls (fake transport) and chat tokens at rest.
import test from "node:test";
import assert from "node:assert/strict";
import {
	attachmentViolation,
	bookingChatWindow,
	chatSessionRefusal,
	counterpartyDecision,
	decidePair,
	demoPairPolicy,
	messageMetadata,
	pairChatState,
	reportedMessageMatches,
	shouldPushChatMessage,
	verifyBasicAuth,
	webhookEventKey,
	type BookingForChat,
} from "../lib/chat/chatRules";
import { chatConfig } from "../config/chat";
import { createCometChatClient, toChatMessage, CometChatError, ChatNotConfiguredError } from "../lib/chat/cometchat";
import { openChatToken, sealChatToken } from "../lib/chat/chatTokens";
import {
	aliasesToForget,
	chatPreview,
	chatPushContent,
	newPushAlias,
	PUSH_ALIAS,
	PUSH_OFF,
	pushTargets,
} from "../lib/push";

const DAY = 24 * 60 * 60 * 1000;
const GRACE = 7 * DAY;
const now = new Date("2026-11-19T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const customer = "64b7f0c2a1b2c3d4e5f60718";
const provider = "64b7f0c2a1b2c3d4e5f60719";

const booking = (fields: Partial<BookingForChat>): BookingForChat => ({
	_id: "65b7f0c2a1b2c3d4e5f60700",
	status: "pending",
	userId: customer,
	providerId: provider,
	...fields,
});

test("lifecycle: no chat until a provider accepts; open while accepted or in progress", () => {
	assert.equal(bookingChatWindow(booking({ providerId: null }), now, GRACE).open, false, "open job");
	assert.deepEqual(bookingChatWindow(booking({}), now, GRACE), { open: true, until: null, reason: "active" });
	assert.equal(bookingChatWindow(booking({ status: "in progress" }), now, GRACE).open, true);
});

test("lifecycle: completed and cancelled stay open for the grace period, then close", () => {
	const justDone = bookingChatWindow(booking({ status: "completed", completedAt: ago(DAY) }), now, GRACE);
	assert.equal(justDone.open, true);
	assert.equal(justDone.reason, "grace");
	assert.equal(justDone.until!.getTime(), ago(DAY).getTime() + GRACE);
	assert.equal(
		bookingChatWindow(booking({ status: "completed", completedAt: ago(8 * DAY) }), now, GRACE).open,
		false,
	);
	assert.equal(bookingChatWindow(booking({ status: "cancelled", cancelledAt: ago(DAY) }), now, GRACE).open, true);
	assert.equal(bookingChatWindow(booking({ status: "cancelled", cancelledAt: ago(GRACE) }), now, GRACE).open, false);
	assert.equal(
		bookingChatWindow(booking({ status: "completed", completedAt: ago(1) }), now, 0).open,
		false,
		"no grace",
	);
	assert.equal(
		bookingChatWindow(booking({ status: "completed", completedAt: null, updatedAt: ago(DAY) }), now, GRACE).open,
		true,
		"older records fall back to updatedAt",
	);
});

test("lifecycle: released back to open and expired bookings open nothing", () => {
	// Release clears providerId; expiry cancels an unassigned booking.
	assert.equal(bookingChatWindow(booking({ providerId: null }), now, GRACE).reason, "unassigned");
	assert.equal(
		bookingChatWindow(booking({ status: "cancelled", providerId: null, cancelledAt: ago(1) }), now, GRACE).open,
		false,
	);
});

test("pair: any booking in its window allows it; until is the latest end unless one is still active", () => {
	const old = booking({ _id: "a", status: "completed", completedAt: ago(30 * DAY) });
	const recent = booking({ _id: "b", status: "completed", completedAt: ago(2 * DAY) });
	const cancelled = booking({ _id: "c", status: "cancelled", cancelledAt: ago(DAY) });
	const state = pairChatState([old, recent, cancelled], now, GRACE);
	assert.equal(state.allowed, true);
	assert.deepEqual(state.bookingIds, ["b", "c"]);
	assert.equal(state.until!.getTime(), ago(DAY).getTime() + GRACE);
	const active = pairChatState([recent, booking({ _id: "d" })], now, GRACE);
	assert.equal(active.until, null, "an active booking keeps it open with no end");
	assert.deepEqual(pairChatState([old], now, GRACE), { allowed: false, until: null, bookingIds: [] });
	assert.deepEqual(pairChatState([], now, GRACE), { allowed: false, until: null, bookingIds: [] });
});

test("demo accounts: only with each other, under the same booking rule", () => {
	assert.equal(demoPairPolicy(true, true), "bookings");
	assert.equal(demoPairPolicy(true, false), "never");
	assert.equal(demoPairPolicy(false, true), "never");
	assert.equal(demoPairPolicy(false, false), "bookings");
	const accepted = [booking({})];
	assert.equal(decidePair(accepted, { customerIsDemo: true, providerIsDemo: false }, now, GRACE).allowed, false);
	assert.equal(decidePair(accepted, { customerIsDemo: true, providerIsDemo: true }, now, GRACE).allowed, true);
	assert.equal(decidePair([], { customerIsDemo: true, providerIsDemo: true }, now, GRACE).allowed, false);
});

test("chat sessions: refused when suspended, unverified or chat-suspended", () => {
	assert.equal(chatSessionRefusal({ isEmailVerified: true }), null);
	assert.equal(chatSessionRefusal({ isEmailVerified: false })?.code, "chat_email_unverified");
	assert.equal(chatSessionRefusal({ isEmailVerified: true, suspended: true })?.code, "account_suspended");
	assert.equal(chatSessionRefusal({ isEmailVerified: true, chatSuspended: true })?.code, "chat_suspended");
	assert.equal(chatSessionRefusal({ isEmailVerified: true, chatSuspended: true })?.status, 403);
});

test("webhook Basic auth: exact username and password only", () => {
	const header = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
	const password = "a".repeat(32);
	assert.equal(verifyBasicAuth(header("hook", password), "hook", password), true);
	assert.equal(verifyBasicAuth(header("hook", password + "x"), "hook", password), false);
	assert.equal(verifyBasicAuth(header("Hook", password), "hook", password), false);
	assert.equal(verifyBasicAuth(header("hook", ""), "hook", password), false);
	assert.equal(verifyBasicAuth(`Bearer ${password}`, "hook", password), false);
	assert.equal(verifyBasicAuth(undefined, "hook", password), false);
	assert.equal(verifyBasicAuth(header("", ""), "", ""), false, "never passes while unconfigured");
	assert.equal(verifyBasicAuth("Basic !!!", "hook", password), false);
});

test("chat config: env only, the old key name still read, sane bounds", () => {
	const off = chatConfig({});
	assert.equal(off.configured, false);
	assert.equal(off.baseUrl, "");
	const on = chatConfig({
		COMETCHAT_APP_ID: "26925431c1f0b1aa",
		COMETCHAT_REGION: "EU",
		COMET_CHAT_REST_API_KEY: "old-name-key",
		CHAT_GRACE_DAYS: "3",
		COMETCHAT_WEBHOOK_USERNAME: "hook",
		COMETCHAT_WEBHOOK_PASSWORD: "short",
	});
	assert.equal(on.configured, true);
	assert.equal(on.baseUrl, "https://26925431c1f0b1aa.api-eu.cometchat.io/v3");
	assert.equal(on.restApiKey, "old-name-key");
	assert.equal(on.graceMs, 3 * DAY);
	assert.equal(on.webhook.configured, false, "a short webhook password is refused");
	assert.equal(chatConfig({ CHAT_GRACE_DAYS: "-1" }).graceMs, 7 * DAY);
	assert.equal(
		chatConfig({ COMETCHAT_APP_ID: "x/../evil", COMETCHAT_REGION: "eu", COMETCHAT_REST_API_KEY: "k" }).configured,
		false,
	);
	assert.equal(
		chatConfig({ COMETCHAT_APP_ID: "abcdef12", COMETCHAT_REGION: "mars", COMETCHAT_REST_API_KEY: "k" }).configured,
		false,
	);
});

const media = (type: string, attachments: { mimeType: string | null; size: number | null }[]) =>
	({ type, attachments: attachments.map((a) => ({ ...a, extension: null })) }) as any;

test("attachments: allowed types and sizes only", () => {
	const policy = { maxBytes: 10 * 1024 * 1024, types: ["image/jpeg", "application/pdf"] };
	assert.equal(attachmentViolation({ type: "text", attachments: [] }, policy), null);
	assert.equal(attachmentViolation(media("image", [{ mimeType: "image/jpeg", size: 1000 }]), policy), null);
	assert.equal(
		attachmentViolation(media("file", [{ mimeType: "application/x-msdownload", size: 10 }]), policy),
		"type",
	);
	assert.equal(
		attachmentViolation(media("image", [{ mimeType: "image/jpeg", size: 11 * 1024 * 1024 }]), policy),
		"size",
	);
	assert.equal(attachmentViolation(media("image", [{ mimeType: "image/jpeg", size: null }]), policy), "unknown");
	assert.equal(attachmentViolation(media("video", []), policy), "unknown");
});

test("webhook messages: parsed without links; recorded as counts, never text", () => {
	const message = toChatMessage({
		id: 42,
		sender: customer,
		receiver: provider,
		receiverType: "user",
		category: "message",
		type: "image",
		data: {
			text: "secret words",
			url: "https://data-eu.cometchat.io/x.jpg",
			attachments: [
				{ name: "x.jpg", extension: "JPG", size: "2048", mimeType: "IMAGE/JPEG", url: "https://..." },
			],
		},
		sentAt: 1_700_000_000,
	})!;
	assert.equal(message.id, "42");
	assert.deepEqual(message.attachments, [{ mimeType: "image/jpeg", size: 2048, extension: "jpg" }]);
	const meta = messageMetadata(message);
	assert.equal(JSON.stringify(meta).includes("secret"), false);
	assert.equal(JSON.stringify(meta).includes("http"), false);
	assert.equal(meta.textLength, 12);
	assert.deepEqual(meta.attachmentTypes, ["image/jpeg"]);
	assert.equal(toChatMessage(null), null);
	assert.equal(webhookEventKey("message_sent", { message: { id: 42 } }), "message_sent:42");
	assert.equal(webhookEventKey("user_blocked", { by: { uid: customer } }), null, "blocks always apply");
	assert.equal(webhookEventKey("message_sent", {}), null);
});

test("reports and blocks: only counterparties, never yourself; a reported message must be theirs to you", () => {
	assert.equal(counterpartyDecision({ selfId: customer, targetId: provider, related: true }), "ok");
	assert.equal(counterpartyDecision({ selfId: customer, targetId: provider, related: false }), "not_counterparty");
	assert.equal(counterpartyDecision({ selfId: customer, targetId: customer, related: true }), "self");
	const message = { sender: provider, receiver: customer, receiverType: "user" } as any;
	assert.equal(reportedMessageMatches(message, customer, provider), true);
	assert.equal(reportedMessageMatches(message, provider, customer), false, "your own message");
	assert.equal(reportedMessageMatches({ ...message, receiver: "someone-else" }, customer, provider), false);
	assert.equal(reportedMessageMatches({ ...message, receiverType: "group" }, customer, provider), false);
	assert.equal(reportedMessageMatches(null, customer, provider), false);
});

test("push decision: allowed conversation only, not blocked, not while viewing, once per burst", () => {
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
	for (const change of [
		{ enabled: false },
		{ receiverType: "group" },
		{ allowed: false },
		{ viewingConversation: true },
		{ recentlyPushed: true },
		{ blockedEitherWay: true },
		{ receiverChatSuspended: true },
		{ removed: true },
	]) {
		assert.equal(shouldPushChatMessage({ ...base, ...change }), false, JSON.stringify(change));
	}
});

test("push content: first name and a short preview, or no text at all; collapsed per conversation", () => {
	const long = "x".repeat(500);
	const content = chatPushContent({
		senderFirstName: "Sam",
		senderUid: provider,
		text: long,
		type: "text",
		preview: true,
		webAppUrl: "https://helphive.himaiz.com",
	});
	assert.equal(content.headings.en, "Sam");
	assert.ok(content.contents.en.length <= 60, "never the full body");
	assert.equal(content.collapse_id, `chat-${provider}`);
	assert.equal(content.android_group, content.collapse_id);
	assert.equal(content.data.deepLink, `helphive://chat/${provider}`);
	assert.equal(content.data.webUrl, `https://helphive.himaiz.com/chat/${provider}`);
	const silent = chatPushContent({
		senderFirstName: "Sam",
		senderUid: provider,
		text: "meet at the staff entrance",
		type: "text",
		preview: false,
		webAppUrl: "https://helphive.himaiz.com",
	});
	assert.equal(silent.contents.en, "Sam sent you a message");
	assert.equal(JSON.stringify(silent).includes("staff entrance"), false);
	assert.equal(chatPreview(null, "image"), "sent a photo");
	assert.equal(chatPreview("  hello\n there ", "text"), "hello there");
});

const session = (fields: Record<string, unknown>) => ({ sessionId: "s", lastUsedAt: now, ...fields });

test("push targets: only active sessions' own aliases; older apps by user id; nobody after sign-out", () => {
	const alias = newPushAlias();
	assert.ok(PUSH_ALIAS.test(alias));
	const user = (sessions: any[], extra: Record<string, unknown> = {}) => ({ _id: customer, sessions, ...extra });
	assert.deepEqual(pushTargets([user([session({ pushAlias: alias })])], now, true), [alias]);
	assert.deepEqual(pushTargets([user([session({})])], now, true), [customer], "an older app's session");
	assert.deepEqual(pushTargets([user([session({})])], now, false), [], "legacy targeting turned off");
	assert.deepEqual(pushTargets([user([])], now, true), [], "signed out everywhere: nothing");
	assert.deepEqual(pushTargets([user([session({ pushAlias: alias })], { suspended: true })], now, true), []);
	assert.deepEqual(
		pushTargets([user([session({ pushAlias: PUSH_OFF })])], now, true),
		[],
		"turned off on the device",
	);
	assert.deepEqual(
		pushTargets([user([session({ pushAlias: alias, lastUsedAt: ago(31 * DAY) })])], now, true),
		[],
		"a session past its refresh-token life gets nothing",
	);
	assert.deepEqual(
		pushTargets([user([session({ pushAlias: "64b7f0c2a1b2c3d4e5f60719" })])], now, true),
		[customer],
		"a forged alias is never targeted",
	);
	assert.deepEqual(
		pushTargets([user([], { sessionId: "legacy" })], now, true),
		[customer],
		"pre-multi-session login",
	);
});

test("push aliases to forget when sessions end, including the user id once no older-app session remains", () => {
	const a = newPushAlias();
	const b = newPushAlias();
	assert.deepEqual(aliasesToForget(customer, [{ pushAlias: a }], [{ pushAlias: b }]), [a, customer]);
	assert.deepEqual(aliasesToForget(customer, [{ pushAlias: a }], [{}]), [a], "an older app is still signed in");
	assert.deepEqual(aliasesToForget(customer, [{ pushAlias: a }, { pushAlias: b }], []), [a, b, customer]);
	assert.deepEqual(aliasesToForget(customer, [{ pushAlias: "not-ours" }], [], true), [], "legacy login remains");
});

test("CometChat client: REST paths, key only in the transport, onBehalfOf, friends and tokens", async () => {
	const sent: any[] = [];
	const config = () =>
		chatConfig({ COMETCHAT_APP_ID: "abcdef123", COMETCHAT_REGION: "eu", COMETCHAT_REST_API_KEY: "rest-key" });
	const client = createCometChatClient({
		config,
		transport: async (request) => {
			sent.push(request);
			if (request.path.endsWith("/auth_tokens")) return { status: 200, data: { data: { authToken: "tok_1" } } };
			if (request.path === "/conversations")
				return {
					status: 200,
					data: { data: [{ unreadMessageCount: "2" }, { unreadMessageCount: 3 }, { unreadMessageCount: 0 }] },
				};
			if (request.method === "POST" && request.path === "/users")
				return { status: 400, data: { error: { code: "ERR_UID_ALREADY_EXISTS" } } };
			if (request.path.endsWith("/friends") && request.method === "GET")
				return { status: 200, data: { data: [{ uid: provider }, { name: "no uid" }] } };
			return { status: 200, data: { data: {} } };
		},
	});
	assert.equal(await client.createAuthToken(customer), "tok_1");
	assert.deepEqual(sent[0].body, { force: true });
	assert.equal(sent[0].baseUrl, "https://abcdef123.api-eu.cometchat.io/v3");
	assert.equal(sent[0].apiKey, "rest-key");
	await client.addFriend(customer, provider);
	assert.deepEqual(sent[1], {
		...sent[1],
		method: "POST",
		path: `/users/${customer}/friends`,
		body: { accepted: [provider] },
	});
	await client.removeFriend(customer, provider);
	assert.deepEqual(sent[2].body, { friends: [provider] });
	assert.deepEqual(await client.unreadCount(customer), { unreadCount: 5, conversations: 2 });
	assert.equal(sent[3].onBehalfOf, customer);
	assert.equal(sent[3].query.unread, true);
	assert.equal(await client.createUser({ uid: customer, name: "A" }), null, "existing user is fine");
	assert.deepEqual(await client.listFriends(customer), [provider]);
	await client.blockUser(customer, provider);
	assert.deepEqual(sent.at(-1).body, { blockedUids: [provider] });
	await client.flushAuthTokens(customer);
	assert.equal(sent.at(-1).method, "DELETE");
	assert.equal(sent.at(-1).path, `/users/${customer}/auth_tokens`);

	const failing = createCometChatClient({
		config,
		transport: async () => ({ status: 403, data: { error: { code: "ERR_PERMISSION_DENIED" } } }),
	});
	await assert.rejects(
		failing.addFriend(customer, provider),
		(e: any) => e instanceof CometChatError && e.code === "ERR_PERMISSION_DENIED",
	);
	const unconfigured = createCometChatClient({
		config: () => chatConfig({}),
		transport: async () => assert.fail("no call"),
	});
	await assert.rejects(unconfigured.createAuthToken(customer), ChatNotConfiguredError);
});

test("chat tokens at rest: encrypted, readable back, unreadable after a key change", () => {
	process.env.CHAT_TOKEN_ENCRYPTION_KEY = "k".repeat(64);
	const sealed = sealChatToken("cometchat-auth-token-123");
	assert.ok(!sealed.includes("cometchat-auth-token-123"));
	assert.equal(openChatToken(sealed), "cometchat-auth-token-123");
	process.env.CHAT_TOKEN_ENCRYPTION_KEY = "z".repeat(64);
	assert.equal(openChatToken(sealed), null, "a changed key means a fresh token is issued, not an error");
	assert.equal(openChatToken(undefined), null);
	delete process.env.CHAT_TOKEN_ENCRYPTION_KEY;
});
