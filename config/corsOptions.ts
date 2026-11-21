import type { Request } from "express";
import { CorsOptions, CorsOptionsDelegate } from "cors";
import { isAllowedOrigin } from "./allowedOrigins";
import { isAdminOrigin } from "./adminAuth";
import log from "../lib/logger";

export class CorsError extends Error {}

const baseOptions: CorsOptions = {
	credentials: true,
	methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
	// X-App-* and X-Device-Id: optional client details (lib/requestContext.ts); X-Request-Id: client-chosen request id.
	allowedHeaders: [
		"Content-Type",
		"Authorization",
		"X-Requested-With",
		"X-App-Platform",
		"X-App-Version",
		"X-Device-Id",
		"X-Client-Pass",
		"X-App-Id",
		"X-Request-Id",
	],
	// Lets browser clients read when to retry after a 429, and the request id to quote in a problem report.
	exposedHeaders: ["Retry-After", "RateLimit", "RateLimit-Policy", "X-Request-Id"],
	optionsSuccessStatus: 204,
};

/** True for /admin and anything under it. */
export const isAdminPath = (path: string) => path === "/admin" || path.startsWith("/admin/");

/**
 * The app-wide allow-list for every route, except /admin: only the admin console's origins (ADMIN_CONSOLE_ORIGINS,
 * default https://admin.helphive.himaiz.com, plus localhost for console development) may call it from a browser,
 * with credentials, because the admin refresh cookie rides on those calls.
 */
export const originAllowedFor = (path: string, origin: string | undefined) =>
	isAdminPath(path) ? isAdminOrigin(origin) : isAllowedOrigin(origin);

const corsOptionsDelegate: CorsOptionsDelegate<Request> = (req, callback) => {
	const origin = req.headers.origin;
	if (originAllowedFor(req.path, origin)) return callback(null, { ...baseOptions, origin: true });
	log.warn("Blocked by CORS", { origin, path: req.path });
	callback(new CorsError("Not allowed by CORS"));
};

export default corsOptionsDelegate;
