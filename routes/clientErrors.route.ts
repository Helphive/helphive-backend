// POST /client-errors: public ingestion of JavaScript errors from the web app, the mobile app and the console.
// Mounted in index.ts before the app-wide JSON parser so it has its own small body limit (16 KB) and accepts
// text/plain (navigator.sendBeacon). Strictly limited per client address and per device; answers 202.
import express from "express";
import { createLimiter } from "../middleware/rateLimit";
import { ipKey } from "../middleware/rateLimitKeys";
import { bindRequestContext, markRouteBase } from "../middleware/requestContext";
import { rejectOperatorKeys } from "../middleware/sanitizeInput";
import { handleClientError } from "../controllers/admin/observabilityOps.controller";

const MINUTE = 60_000;

export const clientErrorIpLimiter = createLimiter({
	name: "client-errors-ip",
	rule: { windowMs: 5 * MINUTE, limit: 60 },
	kind: "local",
	key: (req) => ipKey(req.ip),
});

export const clientErrorDeviceLimiter = createLimiter({
	name: "client-errors-device",
	rule: { windowMs: 5 * MINUTE, limit: 20 },
	kind: "local",
	key: (req) => (req.context?.deviceId ? `device:${req.context.deviceId}` : null),
});

const clientErrorsRoute = express.Router();
clientErrorsRoute.use(markRouteBase);

clientErrorsRoute.post(
	"/",
	clientErrorIpLimiter,
	clientErrorDeviceLimiter,
	express.json({ limit: "16kb", type: ["application/json", "text/plain"] }),
	bindRequestContext,
	rejectOperatorKeys,
	handleClientError,
);

export default clientErrorsRoute;
