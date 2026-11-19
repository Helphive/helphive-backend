import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { rateLimit, type Options } from "express-rate-limit";
import { MongoRateLimitStore } from "./mongoRateLimitStore";
import {
	RATE_LIMITS,
	RATE_LIMIT_MESSAGE,
	accountAndIpKey,
	ipKey,
	normalizeEmail,
	refreshSessionKey,
	userOrIpKey,
	type LimitRule,
} from "./rateLimitKeys";

/*
 * Two kinds of limiter:
 * - "shared" ones keep their counters in MongoDB, so the limit holds across every Cloud Run instance. Used where an
 *   attacker gains by spreading requests over instances: sign-in, sign-up, email and password-reset flows, admin
 *   sign-in, booking creation, payment intents and payouts.
 * - "local" ones count in this instance's memory. With N instances a client can get up to N times the limit, and the
 *   counts reset when an instance restarts. They bound bursts and resource use, not totals.
 * Every 429 carries Retry-After and a JSON { message }.
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
}

export const createLimiter = ({ name, rule, kind, key, failuresOnly, isFailure, limit }: LimiterSpec) =>
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
		...(kind === "shared" ? { store: new MongoRateLimitStore(name) } : {}),
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
	key: (req) => (req.path.startsWith("/webhook/") ? null : userOrIpKey(bearerEmail(req), req.ip)),
	limit: (req) => (bearerEmail(req) ? RATE_LIMITS.globalUser.limit : RATE_LIMITS.globalAnonymous.limit),
});

// Sign-in (users). Order matters only for which message wins; all three count.
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
	createLimiter({
		name: "login-account",
		rule: RATE_LIMITS.loginFailuresPerAccount,
		kind: "shared",
		key: byBodyEmail,
		failuresOnly: true,
	}),
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

export const adminLoginLimiters = [
	createLimiter({
		name: "admin-login-ip",
		rule: RATE_LIMITS.adminLoginFailuresPerIp,
		kind: "shared",
		key: byIp,
		failuresOnly: true,
	}),
	createLimiter({
		name: "admin-login-account",
		rule: RATE_LIMITS.adminLoginFailuresPerAccount,
		kind: "shared",
		key: byBodyEmail,
		failuresOnly: true,
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
