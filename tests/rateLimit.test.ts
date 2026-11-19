// Run with: npx ts-node tests/rateLimit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
	FixedWindowCounter,
	KNOWN_ADDRESS_TTL_MS,
	RATE_LIMITS,
	accountAndIpKey,
	accountCapDecision,
	accountCapKey,
	knownAddressKey,
	maxFailuresFromOneAddress,
	clientIpFrom,
	ipKey,
	normalizeEmail,
	refreshSessionKey,
	retryAfterSeconds,
	userOrIpKey,
} from "../middleware/rateLimitKeys";

import { setEventWriter } from "../lib/events";
import { setLogSink } from "../lib/logger";

process.env.ACCESS_TOKEN_SECRET = "test-access-secret";
// No database here: events go nowhere and expected error logs stay quiet.
setEventWriter(async () => undefined);
setLogSink(() => undefined);
// Imported after the secret is set; the limiters read it per request.
const { createLimiter, globalLimiter, lookupKnownAddress } =
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	require("../middleware/rateLimit") as typeof import("../middleware/rateLimit");

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
		removeHeader: (name: string) => delete headers[name.toLowerCase()],
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

const HOUR = 60 * 60 * 1000;

const signInLayers = [
	{
		scope: "user",
		perAddress: RATE_LIMITS.loginFailuresPerIp,
		perAccountAndAddress: RATE_LIMITS.loginFailuresPerAccountAndIp,
		cap: RATE_LIMITS.loginFailuresPerAccount,
	},
	{
		scope: "admin",
		perAddress: RATE_LIMITS.adminLoginFailuresPerIp,
		perAccountAndAddress: RATE_LIMITS.adminLoginFailuresPerAccountAndIp,
		cap: RATE_LIMITS.adminLoginFailuresPerAccount,
	},
] as const;

test("sign-in numbers: users 30/15 min per address, 5/15 min per account+address, 300/hour per account", () => {
	assert.deepEqual(RATE_LIMITS.loginFailuresPerIp, { windowMs: 15 * 60 * 1000, limit: 30 });
	assert.deepEqual(RATE_LIMITS.loginFailuresPerAccountAndIp, { windowMs: 15 * 60 * 1000, limit: 5 });
	assert.deepEqual(RATE_LIMITS.loginFailuresPerAccount, { windowMs: HOUR, limit: 300 });
	assert.deepEqual(RATE_LIMITS.adminLoginFailuresPerIp, { windowMs: 15 * 60 * 1000, limit: 10 });
	assert.deepEqual(RATE_LIMITS.adminLoginFailuresPerAccountAndIp, { windowMs: 15 * 60 * 1000, limit: 5 });
	assert.deepEqual(RATE_LIMITS.adminLoginFailuresPerAccount, { windowMs: HOUR, limit: 100 });
	assert.equal(KNOWN_ADDRESS_TTL_MS, 30 * 24 * HOUR);
});

for (const { scope, perAddress, perAccountAndAddress, cap } of signInLayers) {
	test(`${scope}: one address at its own limit can never trip the account cap (with 2x margin)`, () => {
		// Unaligned fixed windows: one hour can touch five 15-minute windows, so 150 (users) or 50 (admins), not 120/40.
		const fromOneAddress = maxFailuresFromOneAddress(perAddress, cap.windowMs);
		assert.equal(fromOneAddress, perAddress.limit * 5);
		assert.ok(cap.limit >= 2 * fromOneAddress, `cap ${cap.limit} vs ${fromOneAddress} from one address`);
		// The per-account-and-address layer is stricter still for a single account.
		assert.ok(maxFailuresFromOneAddress(perAccountAndAddress, cap.windowMs) < fromOneAddress);
	});

	test(`${scope}: simulated worst case - one address failing every second for 6 hours never reaches the cap`, () => {
		for (const offsetMs of [0, 1, 7 * 60 * 1000, 14 * 60 * 1000 + 59_999]) {
			let now = 1_000_000 + offsetMs;
			const clock = () => now;
			const addressLayer = new FixedWindowCounter(perAddress, clock);
			const capLayer = new FixedWindowCounter(cap, clock);
			// The cap window starts later than the address window, the unaligned case.
			now += offsetMs;
			let maxCount = 0;
			for (let second = 0; second < 6 * 3600; second++, now += 1000) {
				// Limiters run in order; an attempt refused by the address layer never reaches the cap.
				if (!addressLayer.hit("address").allowed) continue;
				const counted = capLayer.hit("account");
				maxCount = Math.max(maxCount, counted.count);
				assert.ok(counted.allowed, `cap tripped at second ${second}`);
			}
			assert.ok(maxCount <= maxFailuresFromOneAddress(perAddress, cap.windowMs));
		}
	});
}

test("account cap keys are hashed, case-insensitive, scoped, and null without an email", () => {
	const key = accountCapKey("user", "Owner@Example.com", "s1");
	assert.match(key ?? "", /^account:[a-f\d]{64}$/);
	assert.equal(key?.includes("owner"), false, "no email in the key");
	assert.equal(accountCapKey("user", " owner@example.com ", "s1"), key);
	assert.notEqual(accountCapKey("admin", "owner@example.com", "s1"), key, "users and admins are counted apart");
	assert.notEqual(accountCapKey("user", "owner@example.com", "s2"), key, "keyed by the server secret");
	assert.equal(accountCapKey("user", { $ne: null }, "s1"), null);
	assert.equal(accountCapKey("user", "", "s1"), null);
});

test("known-address keys are per account and per address, hashed, with IPv6 grouped by /56", () => {
	const key = knownAddressKey("user", "owner@example.com", "203.0.113.7", "s1");
	assert.match(key ?? "", /^known:[a-f\d]{64}$/);
	assert.equal(key?.includes("203.0.113.7"), false, "no address in the key");
	assert.equal(knownAddressKey("user", "OWNER@example.com", "203.0.113.7", "s1"), key);
	assert.notEqual(knownAddressKey("user", "owner@example.com", "203.0.113.8", "s1"), key);
	assert.notEqual(knownAddressKey("user", "other@example.com", "203.0.113.7", "s1"), key);
	assert.notEqual(knownAddressKey("admin", "owner@example.com", "203.0.113.7", "s1"), key);
	assert.equal(
		knownAddressKey("user", "owner@example.com", "2001:db8:abcd:12ff::1", "s1"),
		knownAddressKey("user", "owner@example.com", "2001:db8:abcd:1200::9", "s1"),
	);
	assert.equal(knownAddressKey("user", ["owner@example.com"], "203.0.113.7", "s1"), null);
});

test("over the cap: known addresses pass, unknown ones are refused, a failed lookup is refused (fail closed)", async () => {
	assert.equal(accountCapDecision("known"), "allow");
	assert.equal(accountCapDecision("unknown"), "block");
	assert.equal(accountCapDecision("error"), "block");
	// No usable email means no record can exist (validation rejects such a request anyway); no database call.
	assert.equal(await lookupKnownAddress(null), "unknown");
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a limiter with an over-limit hook lets allowed requests through without Retry-After", async () => {
	const decisions: ("allow" | "block" | "throw")[] = [];
	const limiter = createLimiter({
		name: "test-cap",
		rule: { windowMs: 60_000, limit: 1 },
		kind: "local",
		key: () => "account:x",
		onLimitReached: async (_req, res, next, reject) => {
			const decision = decisions.shift();
			if (decision === "throw") throw new Error("lookup failed");
			if (decision === "block") return reject();
			res.removeHeader("Retry-After");
			next();
		},
	});
	const first = await run(limiter, fakeRequest());
	assert.equal(first.passed, true, "under the limit the hook is not consulted");

	const attempt = async (decision: "allow" | "block" | "throw") => {
		decisions.push(decision);
		const res = fakeResponse();
		let passed = false;
		await limiter(fakeRequest(), res, () => (passed = true));
		await settle();
		return { res, passed };
	};

	const known = await attempt("allow");
	assert.equal(known.passed, true);
	assert.equal(known.res.headers["retry-after"], undefined);

	const unknown = await attempt("block");
	assert.equal(unknown.passed, false);
	assert.equal(unknown.res.statusCode, 429);
	assert.ok(Number(unknown.res.headers["retry-after"]) > 0);
	assert.deepEqual(unknown.res.body, { message: "Too many requests. Please try again later." });

	const broken = await attempt("throw");
	assert.equal(broken.passed, false, "an error in the hook fails closed once the counter is over the limit");
	assert.equal(broken.res.statusCode, 429);
	assert.ok(Number(broken.res.headers["retry-after"]) > 0);
	assert.deepEqual(broken.res.body, { message: "Too many requests. Please try again later." });
});

for (const scope of ["user", "admin"] as const) {
	test(`${scope}: over the cap, a failed or timed-out known-address lookup answers 429 with Retry-After`, async () => {
		// The account-cap hook as wired in middleware/rateLimit.ts, with the lookup answering "error" (its result on an
		// error or a timeout).
		const lookups: ("known" | "error")[] = ["error"];
		const limiter = createLimiter({
			name: `test-${scope}-cap-lookup-error`,
			rule: { windowMs: 60_000, limit: 1 },
			kind: "local",
			key: () => `account:${scope}`,
			onLimitReached: async (_req, res, next, reject) => {
				if (accountCapDecision(lookups.shift() ?? "error") === "block") return reject();
				res.removeHeader("Retry-After");
				next();
			},
		});
		assert.equal((await run(limiter, fakeRequest())).passed, true, "under the cap");
		const res = fakeResponse();
		let passed = false;
		await limiter(fakeRequest(), res, () => (passed = true));
		await settle();
		assert.equal(passed, false);
		assert.equal(res.statusCode, 429);
		assert.ok(Number(res.headers["retry-after"]) > 0);
	});
}
