// Browser origins allowed to call the API (CORS). Deployed environments allow only the production sites; local and LAN
// origins are added only when NODE_ENV is explicitly "development" (local .env). Firebase preview channels are not
// allowed: a PR preview that needs the live API gets a temporary CORS_ALLOWED_ORIGINS entry on Cloud Run.
// Requests without an Origin (the mobile app, webhooks, Cloud Tasks, server-to-server) are not browser calls and pass.

const envOrigins = () =>
	(process.env.CORS_ALLOWED_ORIGINS || "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);

export const PRODUCTION_ORIGINS: readonly string[] = [
	"https://helphive.himaiz.com",
	"https://admin.helphive.himaiz.com",
	"https://api.helphive.himaiz.com",
	// Firebase Hosting's own domains for the same production sites (web: helphivenow, admin: helphive).
	"https://helphivenow.web.app",
	"https://helphivenow.firebaseapp.com",
	"https://helphive.web.app",
	"https://helphive.firebaseapp.com",
];

export const DEVELOPMENT_ORIGINS: readonly RegExp[] = [
	/^http:\/\/localhost:\d+$/,
	/^http:\/\/127\.0\.0\.1:\d+$/,
	/^http:\/\/192\.168\.\d+\.\d+:\d+$/,
	/^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,
	/^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+:\d+$/,
];

/** True only when the server was explicitly started for local development. */
export const isDevelopment = () => process.env.NODE_ENV === "development";

export const isAllowedOrigin = (origin?: string): boolean => {
	if (!origin) return true;
	if (PRODUCTION_ORIGINS.includes(origin) || envOrigins().includes(origin)) return true;
	return isDevelopment() && DEVELOPMENT_ORIGINS.some((pattern) => pattern.test(origin));
};
