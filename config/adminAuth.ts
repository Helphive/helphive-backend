// Admin sign-in settings, read from the environment once. Every default keeps today's behaviour: 8-hour access tokens
// that the current console uses without refreshing.
import { durationFromEnv } from "../lib/duration";
import { keyFromConfig } from "../lib/secretBox";

const warn = (message: string) => process.stderr.write(`${JSON.stringify({ severity: "WARNING", message })}\n`);

/** ADMIN_ACCESS_TOKEN_TTL: lifetime of an admin access token. Default 8h (today). Set 15m once the console refreshes. */
export const ADMIN_ACCESS_TOKEN_TTL_MS = durationFromEnv("ADMIN_ACCESS_TOKEN_TTL", "8h", warn);

/** ADMIN_SESSION_TTL: a sign-in lasts at most this long, however often it refreshes. Default 12h. */
export const ADMIN_SESSION_TTL_MS = Math.max(
	durationFromEnv("ADMIN_SESSION_TTL", "12h", warn),
	ADMIN_ACCESS_TOKEN_TTL_MS,
);

/** ADMIN_SESSION_IDLE_TTL: refresh is refused after this long without any use of the session. Default 2h. */
export const ADMIN_SESSION_IDLE_TTL_MS = durationFromEnv("ADMIN_SESSION_IDLE_TTL", "2h", warn);

/** ADMIN_TEMP_PASSWORD_TTL: a one-time password from admin creation must be used within this. Default 72h. */
export const ADMIN_TEMP_PASSWORD_TTL_MS = durationFromEnv("ADMIN_TEMP_PASSWORD_TTL", "72h", warn);

export const ADMIN_MFA_CHALLENGE_TTL_SECONDS = 5 * 60;
export const ADMIN_MFA_ENROLLMENT_TTL_MS = 15 * 60 * 1000;

export const ADMIN_REFRESH_COOKIE = "hh_admin_refresh";
export const ADMIN_COOKIE_PATH = "/admin";

export const ADMIN_TOKEN_AUDIENCE = "helphive-admin";
export const ADMIN_MFA_AUDIENCE = "helphive-admin-mfa";

/** Signs admin access tokens and MFA challenges. Falls back to the user secret (the audience keeps them apart). */
export const adminTokenSecret = () => process.env.ADMIN_ACCESS_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET || "";

/**
 * Tags refresh tokens (lib/adminRefreshTokens.ts). ADMIN_REFRESH_TOKEN_SECRET when set, else derived from the access
 * token secret. Changing it ends every admin session at its next refresh (they sign in again).
 */
export const adminRefreshKey = () =>
	keyFromConfig(process.env.ADMIN_REFRESH_TOKEN_SECRET || `refresh:${adminTokenSecret()}`, "helphive-admin-refresh");

const DEFAULT_ADMIN_ORIGINS = ["https://admin.helphive.himaiz.com"];
// Console development against a local or live API. The refresh cookie never reaches these from the live API (they
// are a different site, and the cookie is SameSite=Strict), so they can only use the access token.
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

/** ADMIN_CONSOLE_ORIGINS (comma separated) replaces the default admin origin list. */
export const adminConsoleOrigins = (): string[] => {
	const configured = (process.env.ADMIN_CONSOLE_ORIGINS || "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
	return configured.length ? configured : DEFAULT_ADMIN_ORIGINS;
};

/** Whether a browser origin may call /admin routes (with credentials). No origin (server to server) is allowed. */
export const isAdminOrigin = (origin: string | undefined) =>
	!origin || adminConsoleOrigins().includes(origin) || LOCAL_ORIGIN.test(origin);
