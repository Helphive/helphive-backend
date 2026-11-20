// The web link, topic and icons of a push notification: every screen the server sends, role handling, validation of ids
// (nothing from a payload can leave the web app), and that the helper never touches the fields the mobile app reads.
import test from "node:test";
import assert from "node:assert/strict";
import { webPushFields, webPushPath, webPushTopic } from "../lib/pushLinks";
import { chatPushContent } from "../lib/push";

const BOOKING = "65b7f0c2a1b2c3d4e5f60719";
const SENDER = "64b7f0c2a1b2c3d4e5f60718";
const WEB = "https://helphive.himaiz.com";

test("each screen the server sends opens its page in the web app", () => {
	const table: [Record<string, unknown>, string][] = [
		[{ screen: "BookingDetails", bookingId: BOOKING, type: "booking_accepted" }, `/user/booking/${BOOKING}`],
		[{ screen: "BookingDetails", bookingId: BOOKING, type: "booking_expired" }, `/user/booking/${BOOKING}`],
		[{ screen: "MyOrderDetails", bookingId: BOOKING, type: "booking_started" }, `/provider/my-orders/${BOOKING}`],
		[{ screen: "AcceptOrder", bookingId: BOOKING, type: "booking_created" }, `/provider/orders/${BOOKING}`],
		[{ screen: "Earnings", bookingId: BOOKING, type: "payment_succeeded" }, "/provider/earnings"],
		[{ screen: "Earnings", type: "payout_paid" }, "/provider/earnings"],
		[{ screen: "Chat", type: "chat_message", senderUid: SENDER }, `/chat/${SENDER}`],
		[{ screen: "Home", type: "account_approved" }, "/provider/approved"],
		[{ screen: "Home", type: "account_rejected" }, "/provider/rejected"],
		[{ screen: "Home", bookingId: BOOKING, type: "general" }, "/home"],
		[{ type: "announcement" }, "/home"],
	];
	for (const [data, path] of table) assert.equal(webPushPath({ data }), path, JSON.stringify(data));
});

test("a booking opens in the area of the person who gets it", () => {
	const data = { screen: "BookingDetails", bookingId: BOOKING };
	assert.equal(webPushPath({ data, role: "customer" }), `/user/booking/${BOOKING}`);
	assert.equal(webPushPath({ data, role: "provider" }), `/provider/my-orders/${BOOKING}`);
});

test("missing, odd or hostile values fall back to the dashboard", () => {
	assert.equal(webPushPath({}), "/home");
	assert.equal(webPushPath({ data: null }), "/home");
	assert.equal(webPushPath({ data: { screen: "BookingDetails" } }), "/home");
	assert.equal(webPushPath({ data: { screen: "BookingDetails", bookingId: "../../admin" } }), "/home");
	assert.equal(webPushPath({ data: { screen: "BookingDetails", bookingId: `${BOOKING}/../x` } }), "/home");
	assert.equal(webPushPath({ data: { screen: "Chat", senderUid: "https://evil.example" } }), "/home");
	assert.equal(webPushPath({ data: { screen: "Chat", senderUid: 42 } }), "/home");
	assert.equal(webPushPath({ data: { screen: ["Earnings"] } }), "/home");
	assert.equal(webPushPath({ data: { screen: "Unknown", bookingId: BOOKING } }), "/home");
});

test("every path is a path on the web app, never an absolute or protocol-relative address", () => {
	const hostile = ["//evil.example", "https://evil.example", "javascript:alert(1)", "/\\evil.example", ""];
	for (const value of hostile) {
		for (const screen of ["BookingDetails", "MyOrderDetails", "AcceptOrder", "Chat", "Earnings", "Home"]) {
			const path = webPushPath({ data: { screen, bookingId: value, senderUid: value } });
			assert.match(path, /^\/(home|provider|user|chat)(\/[a-z-]+)*(\/[a-f\d]{24})?$/i, `${screen} ${value}`);
			assert.ok(!path.startsWith("//"));
		}
	}
});

test("a topic per conversation or booking, so a repeat replaces the older notification", () => {
	assert.equal(webPushTopic({ data: { screen: "Chat", senderUid: SENDER } }), `chat-${SENDER}`);
	assert.equal(webPushTopic({ data: { screen: "BookingDetails", bookingId: BOOKING } }), `booking-${BOOKING}`);
	assert.equal(webPushTopic({ data: { type: "announcement" } }), null);
	assert.equal(webPushTopic({ data: { screen: "Chat", senderUid: "x" } }), null);
});

test("web fields: absolute link on the web origin, icons, and no topic when there is none", () => {
	const fields = webPushFields({ data: { screen: "Chat", type: "chat_message", senderUid: SENDER } }, WEB);
	assert.deepEqual(fields, {
		web_url: `${WEB}/chat/${SENDER}`,
		web_push_topic: `chat-${SENDER}`,
		chrome_web_icon: `${WEB}/icon.png`,
		chrome_web_badge: `${WEB}/logo-mark.png`,
	});
	const announcement = webPushFields({ data: { type: "announcement" } }, WEB);
	assert.equal(announcement.web_url, `${WEB}/home`);
	assert.ok(!("web_push_topic" in announcement));
});

test("the web fields never include anything the mobile app reads", () => {
	const content = chatPushContent({
		senderFirstName: "Sam",
		senderUid: SENDER,
		text: "hello",
		type: "text",
		preview: true,
		webAppUrl: WEB,
	});
	const fields = webPushFields({ data: content.data }, WEB);
	for (const key of ["headings", "contents", "data", "include_aliases", "collapse_id", "url", "app_url"]) {
		assert.ok(!(key in fields), key);
	}
	// The chat's own data keeps its shape; the web link agrees with the webUrl it already carries.
	assert.equal(fields.web_url, content.data.webUrl);
});
