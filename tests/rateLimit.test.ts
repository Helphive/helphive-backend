// Run with: npx ts-node tests/rateLimit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
	FixedWindowCounter,
	RATE_LIMITS,
	accountAndIpKey,
	clientIpFrom,
	ipKey,
	normalizeEmail,
	refreshSessionKey,
	retryAfterSeconds,
	userOrIpKey,
} from "../middleware/rateLimitKeys";

process.env.ACCESS_TOKEN_SECRET = "test-access-secret";
// Imported after the secret is set; the limiters read it per request.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, globalLimiter } = require("../middleware/rateLimit") as typeof import("../middleware/rateLimit");

test("client IP: one trusted hop takes the address the Google front end appended", () => {
	// A client that forges X-Forwarded-For only adds entries to the left of the real address.
	assert.equal(clientIpFrom("169.254.1.1", "6.6.6.6, 203.0.113.7", 1), "203.0.113.7");
	assert.equal(clientIpFrom("169.254.1.1", "203.0.113.7", 1), "203.0.113.7");
	assert.equal(clientIpFrom("169.254.1.1", ["6.6.6.6", "203.0.113.7"], 1), "203.0.113.7");
	// No header (local run): the socket peer.
	assert.equal(clientIpFrom("127.0.0.1", undefined, 1), "127.0.0.1");
	assert.equal(clientIpFrom("10.0.0.2", "203.0.113.7", 0), "10.0.0.2");
	// More hops than entries: the leftmost entry, as Express does.
	assert.equal(clientIpFrom("10.0.0.2", "203.0.113.7", 5), "203.0.113.7");
	assert.equal(clientIpFrom(undefined, undefined, 1), "unknown");
});

test("keys: signed-in user first, IP otherwise; IPv6 grouped by /56", () => {
	assert.equal(userOrIpKey("Provider@Example.com ", "203.0.113.7"), "user:provider@example.com");
	assert.equal(userOrIpKey(undefined, "203.0.113.7"), "ip:203.0.113.7");
	assert.equal(userOrIpKey("", "203.0.113.7"), "ip:203.0.113.7");
	assert.equal(ipKey("2001:db8:abcd:12ff::1"), ipKey("2001:db8:abcd:1200::9"));
	assert.notEqual(ipKey("2001:db8:abcd:1300::1"), ipKey("2001:db8:abcd:1200::1"));
	assert.equal(accountAndIpKey("A@b.com", "1.2.3.4"), "account:a@b.com|ip:1.2.3.4");
	assert.equal(accountAndIpKey({ $ne: null }, "1.2.3.4"), null);
	assert.equal(normalizeEmail(["a@b.com"]), null);
	assert.equal(normalizeEmail("x".repeat(256)), null);
});

test("refresh limits bucket by the session inside the token, else by IP", () => {
	const token = jwt.sign({ UserInfo: { sessionId: "64b7f0c2a1b2c3d4e5f60718" } }, "any-secret");
	assert.equal(refreshSessionKey(token, "1.2.3.4"), "session:64b7f0c2a1b2c3d4e5f60718");
	assert.equal(refreshSessionKey("not-a-jwt", "1.2.3.4"), "ip:1.2.3.4");
	assert.equal(refreshSessionKey({ token: 1 }, "1.2.3.4"), "ip:1.2.3.4");
	const bogus = jwt.sign({ UserInfo: { sessionId: { $ne: 1 } } }, "x");
	assert.equal(refreshSessionKey(bogus, "1.2.3.4"), "ip:1.2.3.4");
});

test("fixed window counter allows the limit, blocks after it, and resets with the window", () => {
	let now = 1_000_000;
	const counter = new FixedWindowCounter({ windowMs: 60_000, limit: 3 }, () => now);
	assert.deepEqual(
		[1, 2, 3].map(() => counter.hit("a").allowed),
		[true, true, true],
	);
	const blocked = counter.hit("a");
	assert.equal(blocked.allowed, false);
	assert.equal(blocked.retryAfter, 60);
	assert.equal(counter.hit("b").allowed, true, "keys are independent");
	now += 30_000;
	assert.equal(counter.hit("a").retryAfter, 30);
	now += 30_001;
	assert.equal(counter.hit("a").allowed, true, "a new window starts");
	now += 10 * 60_000;
	counter.hit("c");
	assert.equal(counter.size, 1, "expired windows are swept");
	assert.equal(retryAfterSeconds(now, now), 1);
});

test("limits leave normal client use far below the threshold", () => {
	// Mobile: unread-count poll every 60 s plus ~10 requests at start-up and a refetch per screen focus.
	const busyFiveMinutes = 5 /* polls */ + 10 /* start-up */ + 60; /* a focus every 5 s */
	assert.ok(busyFiveMinutes * 4 < RATE_LIMITS.globalUser.limit, "signed-in users have 4x headroom");
	// Access tokens last 10 minutes, so a session refreshes ~1.5 times per 15 minutes.
	assert.ok(RATE_LIMITS.refreshPerSession.limit >= 10);
	// The app sends one availability message per location change (at most every 10 s).
	assert.ok(RATE_LIMITS.wsMessagesPerSocket.limit >= 6 * 3);
	// Only failures count at sign-in, so a shared NAT with many successful logins is never limited.
	assert.ok(RATE_LIMITS.loginFailuresPerAccount.limit <= 30);
	assert.ok(RATE_LIMITS.loginFailuresPerAccountAndIp.limit <= RATE_LIMITS.loginFailuresPerAccount.limit);
});

// Minimal request/response doubles for driving an express-rate-limit middleware without a server.
const fakeRequest = (overrides: Record<string, any> = {}) =>
	({
		ip: "203.0.113.7",
		path: "/auth/user-info",
		originalUrl: "/auth/user-info",
		method: "GET",
		headers: {},
		body: {},
		app: { get: () => 1 },
		...overrides,
	}) as any;

const fakeResponse = () => {
	const headers: Record<string, string> = {};
	const res: any = {
		statusCode: 200,
		headersSent: false,
		writableEnded: false,
		headers,
		body: undefined as unknown,
		setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = String(value)),
		getHeader: (name: string) => headers[name.toLowerCase()],
		append: (name: string, value: string) => (headers[name.toLowerCase()] = String(value)),
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		send(body: unknown) {
			res.body = body;
			res.writableEnded = true;
			return res;
		},
		json(body: unknown) {
			return res.send(body);
		},
		once: () => res,
		on: () => res,
	};
	return res;
};

const run = async (middleware: any, req: any) => {
	const res = fakeResponse();
	let passed = false;
	await middleware(req, res, () => (passed = true));
	return { res, passed };
};

test("a limiter answers 429 with Retry-After and a JSON message once the limit is passed", async () => {
	const limiter = createLimiter({
		name: "test-local",
		rule: { windowMs: 60_000, limit: 2 },
		kind: "local",
		key: (req) => `ip:${req.ip}`,
	});
	assert.equal((await run(limiter, fakeRequest())).passed, true);
	assert.equal((await run(limiter, fakeRequest())).passed, true);
	const { res, passed } = await run(limiter, fakeRequest());
	assert.equal(passed, false);
	assert.equal(res.statusCode, 429);
	assert.ok(Number(res.headers["retry-after"]) > 0);
	assert.deepEqual(res.body, { message: "Too many requests. Please try again later." });
	// Another client is unaffected.
	assert.equal((await run(limiter, fakeRequest({ ip: "198.51.100.1" }))).passed, true);
});

test("a limiter with no key for the request lets it through to validation", async () => {
	const limiter = createLimiter({
		name: "test-email",
		rule: { windowMs: 60_000, limit: 1 },
		kind: "local",
		key: (req) => normalizeEmail(req.body?.email),
	});
	for (let i = 0; i < 3; i++) assert.equal((await run(limiter, fakeRequest({ body: {} }))).passed, true);
});

test("global limiter keys by a valid bearer token's account, and skips webhooks", async () => {
	const token = jwt.sign({ UserInfo: { email: "busy@example.com", sessionId: "x" } }, "test-access-secret");
	const signedIn = fakeRequest({ headers: { authorization: `Bearer ${token}` } });
	const { res } = await run(globalLimiter, signedIn);
	assert.match(res.headers["ratelimit-policy"] ?? "", new RegExp(`^${RATE_LIMITS.globalUser.limit};`));
	const anonymous = await run(globalLimiter, fakeRequest({ ip: "198.51.100.9" }));
	assert.match(anonymous.res.headers["ratelimit-policy"] ?? "", new RegExp(`^${RATE_LIMITS.globalAnonymous.limit};`));
	// A forged token is treated as anonymous.
	const forged = jwt.sign({ UserInfo: { email: "busy@example.com" } }, "wrong-secret");
	const forgedRun = await run(globalLimiter, fakeRequest({ headers: { authorization: `Bearer ${forged}` } }));
	assert.match(forgedRun.res.headers["ratelimit-policy"] ?? "", new RegExp(`^${RATE_LIMITS.globalAnonymous.limit};`));
	const webhook = await run(globalLimiter, fakeRequest({ path: "/webhook/stripe" }));
	assert.equal(webhook.passed, true);
	assert.equal(webhook.res.headers["ratelimit-policy"], undefined);
});
