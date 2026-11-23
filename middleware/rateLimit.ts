import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { rateLimit, type Options } from "express-rate-limit";
import { MongoRateLimitStore, isKnownAddress, rememberKnownAddress } from "./mongoRateLimitStore";
import { EventSampler, emitEvent } from "../lib/events";
import { isDemoAdminEmail } from "../config/demoAccounts";
import { ADMIN_MFA_AUDIENCE, adminTokenSecret } from "../config/adminAuth";
import log from "../lib/logger";
import {
	KNOWN_ADDRESS_TTL_MS,
	RATE_LIMITS,
	RATE_LIMIT_MESSAGE,
	accountAndIpKey,
	accountCapDecision,
	accountCapKey,
	adminRefreshKey,
	mfaChallengeKey,
	ipKey,
	knownAddressKey,
	normalizeEmail,
	refreshSessionKey,
	userOrIpKey,
	type KnownAddressLookup,
	type LimitRule,
	type SignInScope,
} from "./rateLimitKeys";

/*
 * Two kinds of limiter:
 * - "shared" ones keep their counters in MongoDB, so the limit holds across every Cloud Run instance. Used where an
 *   attacker gains by spreading requests over instances: sign-in, sign-up, email and password-reset flows, admin
 *   sign-in, booking creation, payment intents and payouts.
 * - "local" ones count in this instance's memory. With N instances a client can get up to N times the limit, and the
 *   counts reset when an instance restarts. They bound bursts and resource use, not totals.
 * Every 429 carries Retry-After and a JSON { message }. Shared limiters fail open when the counter store itself is
 * unavailable (passOnStoreError): a database outage must not lock everyone out.
 *
 * Sign-in (users and admins) has three layers, all counting failed attempts only (a success is uncounted again):
 * 1. Per client address (users 30, admins 10 per 15 min): bounds what one source can try against all accounts.
 * 2. Per account and address (5 per 15 min): bounds what one source can try against one account.
 * 3. Per account across all addresses (users 300, admins 100 per hour): bounds guessing spread over many addresses.
 *    A hard limit on the account alone would let anyone who knows an email keep that account locked out, so this one
 *    is set at twice what a single address can ever send (layer 1 caps that; tests/rateLimit.test.ts asserts it),
 *    and when it is exceeded only addresses that have NOT signed in to that account in the last 30 days get 429.
 *    Each successful sign-in records its (account, address) pair, as a keyed hash, for 30 days.
 *    Once the counter has confirmed the account is over its cap, the known-address lookup must answer "known" for the
 *    attempt to proceed: a lookup that fails or times out gets 429 with Retry-After (fail closed), for users and
 *    admins alike. Only a failure of the counter store itself fails open.
 * Trade-off: during an attack big enough to reach layer 3 (12+ addresses for a user, 4+ for an admin, as layer 2 lets
 * each address add at most 25 an hour), the real owner can still sign in from any address they used in the last 30
 * days, but not from a new one (a new phone network, a hotel Wi-Fi) until the hour window ends. The attacker's guesses from new addresses stop at the cap. The known-address lookup costs a
 * database round trip only for attempts already over the cap; below it, layer 3 is one counter update like any other
 * shared limiter. Admin sign-in will additionally get a second factor, which is the stronger protection there.
 */

type Kind = "shared" | "local";

interface LimiterSpec {
	name: string;
	rule: LimitRule;
	kind: Kind;
	key: (req: Request) => string | null;
	// Count only responses that look like a failure (wrong password, bad signature).
	failuresOnly?: boolean;
	isFailure?: (req: Request, res: Response) => boolean;
	limit?: (req: Request) => number;
	// Called instead of the 429 once the limit is passed; it either calls next() or reject().
	onLimitReached?: (req: Request, res: Response, next: NextFunction, reject: () => void) => Promise<void>;
}

// Refusals are recorded as security.rate_limited events, sampled so an attack cannot flood the collection: the first
// per limiter and client key every 10 minutes, at most 60 a minute per instance.
const rateLimitSampler = new EventSampler();

const recordLimited = (name: string, req: Request, key: string | null) => {
	try {
		const sample = rateLimitSampler.take(`${name}|${key ?? "?"}`);
		if (!sample) return;
		emitEvent(
			{
				type: "security.rate_limited",
				actor: { type: "anonymous" },
				properties: { limiter: name, path: req.path, suppressed: sample.suppressed },
			},
			req,
		);
	} catch {
		// Recording is best effort.
	}
};

const sendLimited = (res: Response) => {
	if (!res.headersSent) res.status(429).json({ message: RATE_LIMIT_MESSAGE });
};

export const createLimiter = ({ name, rule, kind, key, failuresOnly, isFailure, limit, onLimitReached }: LimiterSpec) =>
	rateLimit({
		windowMs: rule.windowMs,
		limit: limit ?? rule.limit,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		message: { message: RATE_LIMIT_MESSAGE },
		statusCode: 429,
		// A request without the identifying field (e.g. no email) is left to validation instead.
		skip: (req) => key(req) === null,
		keyGenerator: (req) => key(req) as string,
		...(failuresOnly ? { skipSuccessfulRequests: true } : {}),
		...(isFailure ? { requestWasSuccessful: (req: Request, res: Response) => !isFailure(req, res) } : {}),
		// If MongoDB is unreachable the request goes through rather than locking everyone out.
		passOnStoreError: true,
		// Store errors and configuration warnings go through the app logger, not the console (OracleVMOps LOGGING.md).
		logger: {
			error: (error: unknown, message?: string) =>
				log.error("rate_limiter_store_failed", `Rate limiter ${name}: ${message ?? "store error"}`, error),
			warn: (error: unknown, message?: string) =>
				log.warn("rate_limiter_warning", `Rate limiter ${name}: ${message ?? "warning"}`, error),
		},
		...(kind === "shared" ? { store: new MongoRateLimitStore(name) } : {}),
		handler: (req: Request, res: Response, next: NextFunction) => {
			const reject = () => {
				recordLimited(name, req, key(req));
				sendLimited(res);
			};
			if (!onLimitReached) return reject();
			// The counter already confirmed the limit is passed; if the hook cannot decide, refuse (fail closed).
			onLimitReached(req, res, next, reject).catch((error) => {
				log.error("rate_limiter_failed", `Rate limiter ${name} could not decide; refusing the request`, error);
				reject();
			});
		},
	} as Partial<Options>);

const accessTokenKey = () => process.env.ACCESS_TOKEN_SECRET || "";

/** Email of a valid bearer token (signature and expiry only, no database), cached on the request. */
const bearerEmail = (req: Request): string | null => {
	const cached = (req as any).rateLimitEmail;
	if (cached !== undefined) return cached;
	let email: string | null = null;
	const header = req.headers.authorization;
	if (header?.startsWith("Bearer ")) {
		try {
			const decoded = jwt.verify(header.slice(7), accessTokenKey(), { algorithms: ["HS256"] }) as any;
			email = normalizeEmail(decoded?.UserInfo?.email);
		} catch {
			email = null;
		}
	}
	(req as any).rateLimitEmail = email;
	return email;
};

const byIp = (req: Request) => ipKey(req.ip);
// After verifyJWT, req.user is the signed-in email.
const byUser = (req: Request) => userOrIpKey((req as Request & { user?: string }).user, req.ip);
const byBodyEmail = (req: Request) => {
	const email = normalizeEmail(req.body?.email);
	return email ? `email:${email}` : null;
};

export const globalLimiter = createLimiter({
	name: "global",
	rule: RATE_LIMITS.globalUser,
	kind: "local",
	// Webhooks are limited separately; health probes are never limited.
	key: (req) =>
		req.path.startsWith("/webhook/") || req.path === "/healthz" || req.path === "/livez" || req.path === "/readyz"
			? null
			: userOrIpKey(bearerEmail(req), req.ip),
	limit: (req) => (bearerEmail(req) ? RATE_LIMITS.globalUser.limit : RATE_LIMITS.globalAnonymous.limit),
});

/** Keys sign-in hashes; a stable server secret so the database holds no emails or addresses for them. */
const signInHashSecret = () => process.env.RATE_LIMIT_HASH_SECRET || process.env.ACCESS_TOKEN_SECRET || "";

// Lookups of known addresses give up after this; an over-cap attempt whose lookup fails is refused (fail closed).
const KNOWN_ADDRESS_LOOKUP_TIMEOUT_MS = 2000;

export const lookupKnownAddress = async (key: string | null): Promise<KnownAddressLookup> => {
	if (!key) return "unknown";
	let timer: NodeJS.Timeout | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("known-address lookup timed out")),
				KNOWN_ADDRESS_LOOKUP_TIMEOUT_MS,
			);
		});
		return (await Promise.race([isKnownAddress(key), timeout])) ? "known" : "unknown";
	} catch (error) {
		log.error(
			"known_address_lookup_failed",
			"Known-address lookup failed; refusing the over-cap sign-in attempt",
			error,
		);
		return "error";
	} finally {
		if (timer) clearTimeout(timer);
	}
};

/** Layer 3: the per-account cap, which addresses known to the account pass even when it is exceeded. */
const accountCapLimiter = (scope: SignInScope, rule: LimitRule) =>
	createLimiter({
		name: `${scope === "admin" ? "admin-" : ""}login-account`,
		rule,
		kind: "shared",
		// The demo admin's password is public and many visitors share it, so there is nothing to guess and a cap on
		// the account would only let anyone lock it for everyone. It is exempt from this layer; its sign-ins are
		// limited per address instead (middleware/demoAdmin.ts), and layers 1 and 2 still apply per address.
		key: (req) =>
			scope === "admin" && isDemoAdminEmail(req.body?.email)
				? null
				: accountCapKey(scope, req.body?.email, signInHashSecret()),
		failuresOnly: true,
		onLimitReached: async (req, res, next, reject) => {
			const lookup = await lookupKnownAddress(
				knownAddressKey(scope, req.body?.email, req.ip, signInHashSecret()),
			);
			if (accountCapDecision(lookup) === "block") return reject();
			res.removeHeader("Retry-After");
			next();
		},
	});

/**
 * Call after a successful sign-in: the address is exempt from the account cap for 30 days. Never delays or fails the
 * sign-in itself.
 */
export const recordSuccessfulSignIn = (scope: SignInScope, req: Request, email: unknown = req.body?.email) => {
	const key = knownAddressKey(scope, email, req.ip, signInHashSecret());
	if (!key) return;
	rememberKnownAddress(key, KNOWN_ADDRESS_TTL_MS).catch((error) =>
		log.error("signin_address_record_failed", "Could not record the sign-in address", error),
	);
};

// Sign-in (users): the three layers described at the top of this file, in this order.
export const loginLimiters = [
	createLimiter({
		name: "login-ip",
		rule: RATE_LIMITS.loginFailuresPerIp,
		kind: "shared",
		key: byIp,
		failuresOnly: true,
	}),
	createLimiter({
		name: "login-account-ip",
		rule: RATE_LIMITS.loginFailuresPerAccountAndIp,
		kind: "shared",
		key: (req) => accountAndIpKey(req.body?.email, req.ip),
		failuresOnly: true,
	}),
	accountCapLimiter("user", RATE_LIMITS.loginFailuresPerAccount),
];

export const signupLimiter = createLimiter({
	name: "signup-ip",
	rule: RATE_LIMITS.signupPerIp,
	kind: "shared",
	key: byIp,
});

export const emailRequestLimiters = (flow: "verify" | "reset") => [
	createLimiter({ name: `${flow}-mail-ip`, rule: RATE_LIMITS.emailRequestPerIp, kind: "shared", key: byIp }),
	createLimiter({
		name: `${flow}-mail-address`,
		rule: RATE_LIMITS.emailRequestPerAddress,
		kind: "shared",
		key: byBodyEmail,
	}),
];

export const resetPasswordLimiter = createLimiter({
	name: "reset-password-ip",
	rule: RATE_LIMITS.resetPasswordPerIp,
	kind: "shared",
	key: byIp,
});

export const verifyEmailLimiter = createLimiter({
	name: "verify-email-ip",
	rule: RATE_LIMITS.verifyEmailPerIp,
	kind: "shared",
	key: byIp,
});

export const refreshLimiters = [
	createLimiter({ name: "refresh-ip", rule: RATE_LIMITS.refreshPerIp, kind: "local", key: byIp }),
	createLimiter({
		name: "refresh-session",
		rule: RATE_LIMITS.refreshPerSession,
		kind: "local",
		key: (req) => refreshSessionKey(req.body?.refreshToken, req.ip),
	}),
];

export const createBookingLimiter = createLimiter({
	name: "create-booking",
	rule: RATE_LIMITS.createBookingPerUser,
	kind: "shared",
	key: byUser,
});

export const paymentIntentLimiter = createLimiter({
	name: "payment-intent",
	rule: RATE_LIMITS.paymentIntentPerUser,
	kind: "shared",
	key: byUser,
});

export const payoutLimiter = createLimiter({
	name: "payout",
	rule: RATE_LIMITS.payoutPerUser,
	kind: "shared",
	key: byUser,
});

export const bookingActionLimiter = createLimiter({
	name: "booking-action",
	rule: RATE_LIMITS.bookingActionPerUser,
	kind: "local",
	key: byUser,
});

export const uploadLimiter = createLimiter({
	name: "upload",
	rule: RATE_LIMITS.uploadPerUser,
	kind: "local",
	key: byUser,
});

// Address lookup: per person (a short burst limit per instance and an hourly total shared across instances, which
// bounds the Google bill) and per client address.
export const placesLimiters = [
	createLimiter({ name: "places-ip", rule: RATE_LIMITS.placesPerIp, kind: "local", key: byIp }),
	createLimiter({ name: "places-user", rule: RATE_LIMITS.placesPerUserMinute, kind: "local", key: byUser }),
	createLimiter({ name: "places-user-hour", rule: RATE_LIMITS.placesPerUserHour, kind: "shared", key: byUser }),
];

export const chatSessionLimiter = createLimiter({
	name: "chat-session",
	rule: RATE_LIMITS.chatSessionPerUser,
	kind: "shared",
	key: byUser,
});

export const pushRegisterLimiter = createLimiter({
	name: "push-register",
	rule: RATE_LIMITS.chatSessionPerUser,
	kind: "local",
	key: byUser,
});

export const chatReadLimiter = createLimiter({
	name: "chat-read",
	rule: RATE_LIMITS.chatReadPerUser,
	kind: "local",
	key: byUser,
});

export const chatWriteLimiter = createLimiter({
	name: "chat-write",
	rule: RATE_LIMITS.chatWritePerUser,
	kind: "shared",
	key: byUser,
});

// Sign-in (admins): the same three layers with lower numbers.
export const adminLoginLimiters = [
	createLimiter({
		name: "admin-login-ip",
		rule: RATE_LIMITS.adminLoginFailuresPerIp,
		kind: "shared",
		key: byIp,
		failuresOnly: true,
	}),
	createLimiter({
		name: "admin-login-account-ip",
		rule: RATE_LIMITS.adminLoginFailuresPerAccountAndIp,
		kind: "shared",
		key: (req) => accountAndIpKey(req.body?.email, req.ip),
		failuresOnly: true,
	}),
	accountCapLimiter("admin", RATE_LIMITS.adminLoginFailuresPerAccount),
];

// Two-step codes: failures only, per admin (shared across addresses) and per address. The admin comes from the
// challenge token at sign-in, or from the signed-in admin for confirm/disable/regenerate; both share one counter.
const signedInAdminId = (req: Request): string | null => {
	const admin = (req as Request & { admin?: { _id: unknown } }).admin;
	return admin ? String(admin._id) : null;
};
// A challenge token only names an admin once its signature, audience and expiry check out. A forged or expired
// token must not be able to spend another admin's attempts, so it gets no per-admin key (the per-address limiter
// still counts it).
const verifiedChallengeKey = (challengeToken: unknown): string | null => {
	if (typeof challengeToken !== "string") return null;
	try {
		jwt.verify(challengeToken, adminTokenSecret(), { audience: ADMIN_MFA_AUDIENCE, algorithms: ["HS256"] });
	} catch {
		return null;
	}
	return mfaChallengeKey(challengeToken);
};
const mfaAdminKey = (req: Request) => {
	const adminId = signedInAdminId(req);
	return adminId ? `mfa-admin:${adminId}` : verifiedChallengeKey(req.body?.challengeToken);
};

export const adminMfaLimiters = [
	createLimiter({
		name: "admin-mfa-ip",
		rule: RATE_LIMITS.adminMfaFailuresPerIp,
		kind: "shared",
		key: byIp,
		failuresOnly: true,
	}),
	createLimiter({
		name: "admin-mfa-admin",
		rule: RATE_LIMITS.adminMfaFailuresPerAdmin,
		kind: "shared",
		key: mfaAdminKey,
		failuresOnly: true,
	}),
];

export const adminPasswordChangeLimiter = createLimiter({
	name: "admin-password-change",
	rule: RATE_LIMITS.adminPasswordChangeFailures,
	kind: "shared",
	key: (req) => {
		const adminId = signedInAdminId(req);
		return adminId ? `admin:${adminId}` : null;
	},
	failuresOnly: true,
});

/** Global search (GET /admin/search), after verifyAdminJWT: per signed-in admin. */
export const adminSearchLimiter = createLimiter({
	name: "admin-search",
	rule: RATE_LIMITS.adminSearchPerAdmin,
	kind: "local",
	key: (req) => {
		const adminId = signedInAdminId(req);
		return adminId ? `admin-search:${adminId}` : null;
	},
});

export const adminRefreshLimiters = [
	createLimiter({ name: "admin-refresh-ip", rule: RATE_LIMITS.refreshPerIp, kind: "local", key: byIp }),
	createLimiter({
		name: "admin-refresh-session",
		rule: RATE_LIMITS.adminRefreshPerSession,
		kind: "local",
		key: (req) => adminRefreshKey(req.cookies?.hh_admin_refresh, req.ip),
	}),
];

/** Counts only calls the endpoint rejected as unauthenticated, so genuine Stripe and Cloud Tasks calls never count. */
export const webhookLimiter = (name: string, rejectedStatus: number) =>
	createLimiter({
		name,
		rule: RATE_LIMITS.webhookFailuresPerIp,
		kind: "local",
		key: byIp,
		failuresOnly: true,
		isFailure: (_req, res) => res.statusCode === rejectedStatus,
	});

export const clientAttestLimiter = createLimiter({
	name: "client-attest-ip",
	rule: RATE_LIMITS.clientAttestPerIp,
	kind: "shared",
	key: byIp,
});
