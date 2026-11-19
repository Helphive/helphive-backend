// Pure helpers for rate limiting: client IP resolution, key selection, the limits table and a small fixed-window
// counter for the websocket. No Express or database imports, so they can be unit tested directly.
import crypto from "crypto";
import { ipKeyGenerator } from "express-rate-limit";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export type LimitRule = { windowMs: number; limit: number };

/**
 * Every limit in one place. The mobile app polls the unread count every 60 s, refetches lists on screen focus and fires
 * a handful of requests together at start-up; a busy session stays well under 100 requests in 5 minutes.
 */
export const RATE_LIMITS = {
	// All API traffic except webhooks. Signed-in clients are keyed by account, anonymous ones by IP.
	globalUser: { windowMs: 5 * MINUTE, limit: 600 },
	globalAnonymous: { windowMs: 5 * MINUTE, limit: 300 },
	// Sign-in: three layers, failed attempts only (see the comment at the top of middleware/rateLimit.ts).
	// 1. Per client address. Successes never count, so staff behind one hotel or carrier IP are not blocked.
	loginFailuresPerIp: { windowMs: 15 * MINUTE, limit: 30 },
	// 2. Per account and address: one source cannot hammer one account.
	loginFailuresPerAccountAndIp: { windowMs: 15 * MINUTE, limit: 5 },
	// 3. Per account across all addresses: stops guessing spread over many addresses. Twice the most one address can
	// send in an hour (see maxFailuresFromOneAddress); once reached, only addresses unknown to the account are refused.
	loginFailuresPerAccount: { windowMs: HOUR, limit: 300 },
	signupPerIp: { windowMs: HOUR, limit: 30 },
	emailRequestPerIp: { windowMs: HOUR, limit: 20 },
	emailRequestPerAddress: { windowMs: HOUR, limit: 5 },
	resetPasswordPerIp: { windowMs: 15 * MINUTE, limit: 10 },
	verifyEmailPerIp: { windowMs: 15 * MINUTE, limit: 20 },
	// A session refreshes about every 10 minutes; 30 in 15 minutes leaves room for retries and parallel tabs.
	refreshPerSession: { windowMs: 15 * MINUTE, limit: 30 },
	refreshPerIp: { windowMs: 15 * MINUTE, limit: 300 },
	createBookingPerUser: { windowMs: HOUR, limit: 30 },
	paymentIntentPerUser: { windowMs: HOUR, limit: 10 },
	payoutPerUser: { windowMs: HOUR, limit: 5 },
	bookingActionPerUser: { windowMs: 15 * MINUTE, limit: 60 },
	uploadPerUser: { windowMs: HOUR, limit: 10 },
	adminLoginFailuresPerIp: { windowMs: 15 * MINUTE, limit: 10 },
	adminLoginFailuresPerAccountAndIp: { windowMs: 15 * MINUTE, limit: 5 },
	adminLoginFailuresPerAccount: { windowMs: HOUR, limit: 100 },
	// Two-step codes (sign-in challenge, and confirm/disable/regenerate while signed in): failures only. Per admin across
	// all addresses, 10 per 15 minutes is about 1,000 guesses a day against a 1-in-333,333 chance per guess (three
	// valid codes in the window): under 0.3% a day, after the password was already right.
	adminMfaFailuresPerAdmin: { windowMs: 15 * MINUTE, limit: 10 },
	adminMfaFailuresPerIp: { windowMs: 15 * MINUTE, limit: 20 },
	// Wrong current password on change-password.
	adminPasswordChangeFailures: { windowMs: 15 * MINUTE, limit: 5 },
	// The public demo admin, keyed by client address (many people share the login): requests made with a demo token,
	// and sign-in attempts to the demo email (successes too, since every visitor signs in).
	demoAdminRequestsPerIp: { windowMs: 5 * MINUTE, limit: 150 },
	demoAdminSignInsPerIp: { windowMs: HOUR, limit: 30 },
	// The console's command palette searches as the admin types (debounced): per admin, per instance.
	adminSearchPerAdmin: { windowMs: MINUTE, limit: 60 },
	// Admin refresh: once per access-token lifetime per tab; room for several tabs and retries.
	adminRefreshPerSession: { windowMs: 15 * MINUTE, limit: 60 },
	// Webhooks and tasks: only rejected (unsigned or unauthorised) calls count, so Stripe and Cloud Tasks never are.
	webhookFailuresPerIp: { windowMs: 15 * MINUTE, limit: 30 },
	wsConnectionsPerIp: { windowMs: MINUTE, limit: 30 },
	// The app sends one message per location change (at most every 10 s) or toggle.
	wsMessagesPerSocket: { windowMs: MINUTE, limit: 60 },
} satisfies Record<string, LimitRule>;

export const RATE_LIMIT_MESSAGE = "Too many requests. Please try again later.";

/**
 * The client IP as Express computes it with `trust proxy` set to a hop count: the address `hops` entries from the
 * right of X-Forwarded-For followed by the socket peer. On Cloud Run the Google front end appends the real client
 * address, so one hop is right and anything a client puts in the header itself is ignored.
 */
export const clientIpFrom = (
	remoteAddress: string | undefined,
	forwardedFor: string | string[] | undefined,
	hops: number,
) => {
	const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor || "";
	const chain = [
		remoteAddress || "",
		...header
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean)
			.reverse(),
	];
	return chain[Math.min(Math.max(hops, 0), chain.length - 1)] || "unknown";
};

/** IPv6 clients are grouped by /56, the usual size of one household or device allocation. */
export const ipKey = (ip: string | undefined) => `ip:${ipKeyGenerator(ip || "unknown", 56)}`;

export const normalizeEmail = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	return email && email.length <= 255 ? email : null;
};

/** The signed-in account when there is one, else the client IP. */
export const userOrIpKey = (user: string | null | undefined, ip: string | undefined) => {
	const email = normalizeEmail(user);
	return email ? `user:${email}` : ipKey(ip);
};

/** Email (as typed in a body) plus IP, for per-account-per-source limits. Null when the body has no usable email. */
export const accountAndIpKey = (email: unknown, ip: string | undefined) => {
	const normalized = normalizeEmail(email);
	return normalized ? `account:${normalized}|${ipKey(ip)}` : null;
};

/** The session id inside a refresh token, read without verifying it; only used to bucket the rate limit. */
export const refreshSessionKey = (refreshToken: unknown, ip: string | undefined) => {
	if (typeof refreshToken === "string") {
		const payload = refreshToken.split(".")[1];
		if (payload && payload.length < 4096) {
			try {
				const sessionId = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.UserInfo?.sessionId;
				if (typeof sessionId === "string" && /^[a-f\d]{24}$/i.test(sessionId)) return `session:${sessionId}`;
			} catch {
				// Not a JWT; fall through to the IP.
			}
		}
	}
	return ipKey(ip);
};

/** Admin id inside a two-step challenge token, read without verifying it; only used to bucket the rate limit. */
export const mfaChallengeKey = (challengeToken: unknown): string | null => {
	if (typeof challengeToken !== "string") return null;
	const payload = challengeToken.split(".")[1];
	if (!payload || payload.length > 2048) return null;
	try {
		const sub = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.sub;
		return typeof sub === "string" && /^[a-f\d]{24}$/i.test(sub) ? `mfa-admin:${sub}` : null;
	} catch {
		return null;
	}
};

/** Session id at the start of an admin refresh token ("<sessionId>.<generation>.<random>.<tag>"), else the IP. */
export const adminRefreshKey = (token: unknown, ip: string | undefined) => {
	const sessionId = typeof token === "string" ? token.split(".")[0] : "";
	return /^[a-f\d]{24}$/i.test(sessionId) ? `admin-session:${sessionId}` : ipKey(ip);
};

/** Seconds until a window that started at `resetAt - windowMs` ends, never less than 1. */
export const retryAfterSeconds = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 1000));

/** In-memory fixed-window counter (per instance), used for websocket connections and messages. */
export class FixedWindowCounter {
	private readonly windows = new Map<string, { count: number; resetAt: number }>();
	private lastSweep = 0;

	constructor(
		private readonly rule: LimitRule,
		private readonly now: () => number = Date.now,
	) {}

	/** Counts one hit for `key`; `allowed` is false once the limit is passed within the window. */
	hit(key: string): { allowed: boolean; retryAfter: number; count: number } {
		const now = this.now();
		this.sweep(now);
		let window = this.windows.get(key);
		if (!window || window.resetAt <= now) {
			window = { count: 0, resetAt: now + this.rule.windowMs };
			this.windows.set(key, window);
		}
		window.count += 1;
		return {
			allowed: window.count <= this.rule.limit,
			retryAfter: retryAfterSeconds(window.resetAt, now),
			count: window.count,
		};
	}

	get size() {
		return this.windows.size;
	}

	private sweep(now: number) {
		if (now - this.lastSweep < this.rule.windowMs) return;
		this.lastSweep = now;
		for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
	}
}

/** How long a successful sign-in makes its (account, address) pair exempt from the per-account cap. */
export const KNOWN_ADDRESS_TTL_MS = 30 * 24 * HOUR;

/**
 * The most failed sign-ins one client address can ever add to an account's counter within one cap window, from the
 * per-address limit alone. Windows are fixed and not aligned with each other, so a cap window can overlap one more
 * per-address window than fits in it (an hour touches up to five 15-minute windows).
 */
export const maxFailuresFromOneAddress = (perAddress: LimitRule, capWindowMs: number) =>
	perAddress.limit * (Math.ceil(capWindowMs / perAddress.windowMs) + 1);

export type SignInScope = "user" | "admin";

/**
 * Keyed hash, so these database keys hold neither emails nor client addresses. The secret only has to be stable: if it
 * changes, remembered addresses are forgotten and owners count as new addresses until they next sign in.
 */
const keyedHash = (secret: string, ...parts: string[]) =>
	crypto
		.createHmac("sha256", secret || "helphive-rate-limit")
		.update(parts.join("\n"))
		.digest("hex");

/** Per-account cap key, or null when the body has no usable email (validation then rejects the request). */
export const accountCapKey = (scope: SignInScope, email: unknown, secret: string) => {
	const normalized = normalizeEmail(email);
	return normalized ? `account:${keyedHash(secret, scope, normalized)}` : null;
};

/** Key of the record "this address signed in to this account". Addresses grouped as in the limits (IPv6 /56). */
export const knownAddressKey = (scope: SignInScope, email: unknown, ip: string | undefined, secret: string) => {
	const normalized = normalizeEmail(email);
	return normalized ? `known:${keyedHash(secret, scope, normalized, ipKey(ip))}` : null;
};

export type KnownAddressLookup = "known" | "unknown" | "error";

/**
 * What happens to a sign-in attempt once its account is over the cap: an address that signed in to the account in the
 * last 30 days goes through; a new one gets 429, and so does one whose lookup failed or timed out (fail closed: the
 * counter has already shown the account is under attack). Only an unavailable counter store fails open, upstream.
 */
export const accountCapDecision = (lookup: KnownAddressLookup): "allow" | "block" =>
	lookup === "known" ? "allow" : "block";
