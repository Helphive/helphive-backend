// Pure helpers for rate limiting: client IP resolution, key selection, the limits table and a small fixed-window
// counter for the websocket. No Express or database imports, so they can be unit tested directly.
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
	// Sign-in: failed attempts only, so many staff signing in behind one hotel or carrier IP are never blocked.
	loginFailuresPerIp: { windowMs: 15 * MINUTE, limit: 30 },
	loginFailuresPerAccountAndIp: { windowMs: 15 * MINUTE, limit: 5 },
	// Guessing one account from many IPs: at most 30 wrong passwords an hour, whatever the source.
	loginFailuresPerAccount: { windowMs: HOUR, limit: 30 },
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
	adminLoginFailuresPerAccount: { windowMs: 15 * MINUTE, limit: 5 },
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
