// Run with: npx ts-node tests/adminSessions.test.ts
// Refresh-token rotation and reuse detection without a database: the token format, the decision function, and the
// default settings that keep the current console working.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
	REFRESH_REUSE_GRACE_MS,
	decideRefresh,
	hashRefreshToken,
	issueRefreshToken,
	parseRefreshToken,
	type RefreshSessionState,
} from "../lib/adminRefreshTokens";

process.env.ACCESS_TOKEN_SECRET = "test-user-secret";
process.env.ADMIN_ACCESS_TOKEN_SECRET = "test-admin-secret";
delete process.env.ADMIN_ACCESS_TOKEN_TTL;
/* eslint-disable @typescript-eslint/no-require-imports */
const adminAuth = require("../config/adminAuth") as typeof import("../config/adminAuth");
const sessions = require("../controllers/admin/adminSessions") as typeof import("../controllers/admin/adminSessions");
const cors = require("../config/corsOptions") as typeof import("../config/corsOptions");
const { mfaChallengeKey, adminRefreshKey } =
	require("../middleware/rateLimitKeys") as typeof import("../middleware/rateLimitKeys");
/* eslint-enable @typescript-eslint/no-require-imports */

const key = crypto.randomBytes(32);
const SESSION = "64b7f0c2a1b2c3d4e5f60718";
const IDLE = 2 * 3600 * 1000;
const t0 = new Date("2026-11-19T09:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

const sessionAt = (generation: number, token: string, previous?: string, rotatedAt?: Date): RefreshSessionState => ({
	generation,
	tokenHash: hashRefreshToken(token),
	previousTokenHash: previous ? hashRefreshToken(previous) : null,
	rotatedAt: rotatedAt ?? null,
	revokedAt: null,
	expiresAt: later(12 * 3600 * 1000),
	lastUsedAt: rotatedAt ?? t0,
});

test("refresh tokens are opaque, tagged with a server key, and a forged or altered one is not recognised", () => {
	const { token, hash } = issueRefreshToken(key, SESSION, 0);
	assert.match(token, /^[a-f\d]{24}\.0\.[\w-]{43}\.[\w-]{32}$/);
	assert.equal(hash, hashRefreshToken(token));
	assert.deepEqual(parseRefreshToken(key, token), { sessionId: SESSION, generation: 0, token });
	assert.equal(parseRefreshToken(crypto.randomBytes(32), token), null, "another server key");
	const [sid, , random, tag] = token.split(".");
	assert.equal(parseRefreshToken(key, `${sid}.7.${random}.${tag}`), null, "generation changed");
	assert.equal(parseRefreshToken(key, `${"0".repeat(24)}.0.${random}.${tag}`), null, "session changed");
	for (const junk of [undefined, 42, "", "a.b.c.d", "x".repeat(300), { token }])
		assert.equal(parseRefreshToken(key, junk), null);
});

test("rotation: the current token rotates; the next one is a different token of the next generation", () => {
	const first = issueRefreshToken(key, SESSION, 0);
	const parsed = parseRefreshToken(key, first.token)!;
	assert.deepEqual(decideRefresh(sessionAt(0, first.token), parsed, later(60_000), IDLE), { kind: "rotate" });
	const second = issueRefreshToken(key, SESSION, 1);
	assert.notEqual(second.token, first.token);
	assert.equal(parseRefreshToken(key, second.token)?.generation, 1);
});

test("reuse: an old token after the grace period revokes the session (family); within it, two tabs racing are fine", () => {
	const g0 = issueRefreshToken(key, SESSION, 0);
	const g1 = issueRefreshToken(key, SESSION, 1);
	const g2 = issueRefreshToken(key, SESSION, 2);
	const rotatedAt = later(10 * 60_000);
	const state = sessionAt(1, g1.token, g0.token, rotatedAt);
	const old = parseRefreshToken(key, g0.token)!;

	assert.deepEqual(decideRefresh(state, old, new Date(rotatedAt.getTime() + 5_000), IDLE), { kind: "grace" });
	assert.deepEqual(decideRefresh(state, old, new Date(rotatedAt.getTime() + REFRESH_REUSE_GRACE_MS + 1), IDLE), {
		kind: "reuse",
	});
	// Two generations back is always reuse, even immediately.
	const state2 = sessionAt(2, g2.token, g1.token, rotatedAt);
	assert.deepEqual(decideRefresh(state2, old, rotatedAt, IDLE), { kind: "reuse" });
	// A genuine-looking token of the current generation that is not the stored one is refused, not treated as reuse.
	const twin = issueRefreshToken(key, SESSION, 1);
	assert.deepEqual(decideRefresh(state, parseRefreshToken(key, twin.token)!, rotatedAt, IDLE), { kind: "invalid" });
	// A future generation cannot exist.
	assert.deepEqual(decideRefresh(sessionAt(0, g0.token), parseRefreshToken(key, g1.token)!, t0, IDLE), {
		kind: "invalid",
	});
});

test("revoked, expired and idle sessions are refused; an unknown session is invalid", () => {
	const g0 = issueRefreshToken(key, SESSION, 0);
	const parsed = parseRefreshToken(key, g0.token)!;
	assert.deepEqual(decideRefresh({ ...sessionAt(0, g0.token), revokedAt: t0 }, parsed, t0, IDLE), {
		kind: "revoked",
	});
	assert.deepEqual(decideRefresh(sessionAt(0, g0.token), parsed, later(13 * 3600 * 1000), IDLE), {
		kind: "expired",
		reason: "absolute",
	});
	assert.deepEqual(decideRefresh(sessionAt(0, g0.token), parsed, later(IDLE + 1), IDLE), {
		kind: "expired",
		reason: "idle",
	});
	assert.deepEqual(decideRefresh(null, parsed, t0, IDLE), { kind: "invalid" });
});

test("defaults keep today's console working: 8-hour access tokens, same claims plus sub/sid, same audience", () => {
	assert.equal(adminAuth.ADMIN_ACCESS_TOKEN_TTL_MS, 8 * 3600 * 1000);
	assert.ok(adminAuth.ADMIN_SESSION_TTL_MS >= adminAuth.ADMIN_ACCESS_TOKEN_TTL_MS);
	const admin: any = {
		_id: SESSION,
		email: "ops@example.com",
		roles: { admin: true, superAdmin: false },
		tokenVersion: 3,
	};
	const { token, expiresAt } = sessions.signAdminAccessToken(admin, "64b7f0c2a1b2c3d4e5f60719");
	const decoded = jwt.verify(token, "test-admin-secret", {
		audience: "helphive-admin",
		algorithms: ["HS256"],
	}) as any;
	assert.deepEqual(decoded.UserInfo, { email: "ops@example.com", roles: [true] });
	assert.equal(decoded.tv, 3);
	assert.equal(decoded.sub, SESSION);
	assert.equal(decoded.sid, "64b7f0c2a1b2c3d4e5f60719");
	assert.equal(decoded.exp - decoded.iat, 8 * 3600);
	assert.ok(Math.abs(expiresAt.getTime() - decoded.exp * 1000) < 2000);
	assert.equal("sid" in (jwt.decode(sessions.signAdminAccessToken(admin).token) as any), false, "sessionless token");
	assert.throws(() => jwt.verify(token, "test-user-secret"), "user secret cannot verify admin tokens");
});

test("refresh cookie: httpOnly, Secure, SameSite=Strict, scoped to /admin", () => {
	assert.deepEqual(sessions.refreshCookieOptions(), {
		httpOnly: true,
		secure: true,
		sameSite: "strict",
		path: "/admin",
	});
	assert.equal(adminAuth.ADMIN_REFRESH_COOKIE, "hh_admin_refresh");
	const fields = sessions.sessionResponseFields(
		{ roles: { admin: true, superAdmin: false } } as any,
		{ expiresAt: t0 },
		{ _id: SESSION as any, expiresAt: later(1000) },
	);
	assert.equal(fields.role, "operations");
	assert.ok(fields.permissions.includes("applications.review"));
	assert.equal(fields.accessTokenExpiresAt, t0.toISOString());
	assert.equal(fields.sessionId, SESSION);
	assert.equal(fields.mustChangePassword, false);
});

test("CORS: /admin only from the console's origins (and localhost for development); other routes unchanged", () => {
	delete process.env.ADMIN_CONSOLE_ORIGINS;
	assert.equal(cors.originAllowedFor("/admin/refresh", "https://admin.helphive.himaiz.com"), true);
	assert.equal(cors.originAllowedFor("/admin/refresh", "http://localhost:5174"), true);
	assert.equal(cors.originAllowedFor("/admin/refresh", "https://helphive.himaiz.com"), false, "the web app");
	assert.equal(cors.originAllowedFor("/admin/login", "http://192.168.1.20:5173"), false, "LAN origins");
	assert.equal(cors.originAllowedFor("/admin/login", "https://evil.example"), false);
	assert.equal(cors.originAllowedFor("/admin", undefined), true, "no Origin (server to server)");
	assert.equal(cors.originAllowedFor("/administrator", "https://helphive.himaiz.com"), true, "not an admin path");
	assert.equal(cors.originAllowedFor("/auth/login", "https://helphive.himaiz.com"), true);
	assert.equal(cors.originAllowedFor("/auth/login", "http://192.168.1.20:5173"), true);
	assert.equal(cors.originAllowedFor("/auth/login", "https://evil.example"), false);
	process.env.ADMIN_CONSOLE_ORIGINS = "https://console.example.com";
	assert.equal(cors.originAllowedFor("/admin/login", "https://console.example.com"), true);
	assert.equal(
		cors.originAllowedFor("/admin/login", "https://admin.helphive.himaiz.com"),
		false,
		"the list is replaced",
	);
	delete process.env.ADMIN_CONSOLE_ORIGINS;
});

test("rate-limit keys for two-step codes and admin refresh come from the token, else fall back", () => {
	const challenge = jwt.sign({ tv: 0 }, "any", { subject: SESSION });
	assert.equal(mfaChallengeKey(challenge), `mfa-admin:${SESSION}`);
	assert.equal(mfaChallengeKey("nonsense"), null);
	assert.equal(mfaChallengeKey(jwt.sign({ sub: { $ne: 1 } }, "x")), null);
	const { token } = issueRefreshToken(key, SESSION, 4);
	assert.equal(adminRefreshKey(token, "1.2.3.4"), `admin-session:${SESSION}`);
	assert.equal(adminRefreshKey(undefined, "1.2.3.4"), "ip:1.2.3.4");
});
