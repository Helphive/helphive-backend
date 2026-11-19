// The public demo admin: read-only, masked, and rate limited per client address. All three are mounted once on the
// admin router (routes/admin.route.ts), so endpoints added later are covered without anyone remembering to.
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { DEMO_ACCOUNT_EMAILS, DEMO_ADMIN_READ_ONLY, isDemoAdminEmail } from "../config/demoAccounts";
import { isDemoAdmin } from "../config/adminPermissions";
import { ADMIN_TOKEN_AUDIENCE, adminTokenSecret } from "../config/adminAuth";
import { maskForDemo } from "../lib/demoMask";
import { recordAudit } from "../lib/audit";
import { authenticateAdmin } from "./verifyAdminJWT";
import { createLimiter } from "./rateLimit";
import { RATE_LIMITS, ipKey } from "./rateLimitKeys";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Writes a demo admin may make: signing in, refreshing and signing out of its own session. Paths are router-relative. */
export const DEMO_ALLOWED_WRITES = new Set(["POST /login", "POST /login/mfa", "POST /refresh", "POST /logout"]);

/** Whether a demo admin may make this request at all. */
export const demoMayRequest = (method: string, path: string) =>
	SAFE_METHODS.has(method.toUpperCase()) ||
	DEMO_ALLOWED_WRITES.has(`${method.toUpperCase()} ${path.replace(/\/+$/, "")}`);

/**
 * Refuses every write by a demo admin (403 demo_read_only), except signing in, refreshing and signing out. Requests
 * from anyone else, and requests with no usable token, continue to the route, which authenticates as usual.
 */
export const demoReadOnly = async (req: Request, res: Response, next: NextFunction) => {
	if (demoMayRequest(req.method, req.path)) return next();
	const auth = await authenticateAdmin(req);
	if (!auth.ok || !isDemoAdmin(auth.admin)) return next();
	await recordAudit(
		{
			action: "demo.write_refused",
			outcome: "failure",
			actor: { type: "admin", id: auth.admin._id, email: auth.admin.email },
			target: { type: "route", id: `${req.method} ${req.baseUrl}${req.path}` },
			demo: true,
		},
		req,
	);
	return res.status(403).json({ ...DEMO_ADMIN_READ_ONLY });
};

/**
 * Masks every successful JSON response to a demo admin (lib/demoMask.ts). Runs at send time, after the route's
 * verifyAdminJWT has set req.admin. Error responses are the API's own messages and are left as they are.
 */
export const demoResponseMask = (req: Request, res: Response, next: NextFunction) => {
	const json = res.json.bind(res);
	res.json = (body?: unknown) => {
		if (req.admin && isDemoAdmin(req.admin) && res.statusCode < 400) {
			return json(maskForDemo(body, { exemptEmails: DEMO_ACCOUNT_EMAILS }));
		}
		return json(body);
	};
	next();
};

/** True when the bearer token is a valid admin token for the demo login (signature only; no database). */
const bearerIsDemo = (req: Request) => {
	const header = req.headers.authorization;
	if (!header?.startsWith("Bearer ")) return false;
	try {
		const claims = jwt.verify(header.slice(7), adminTokenSecret(), {
			algorithms: ["HS256"],
			audience: ADMIN_TOKEN_AUDIENCE,
		}) as { demo?: unknown; UserInfo?: { email?: unknown } };
		return claims.demo === true || isDemoAdminEmail(claims.UserInfo?.email);
	} catch {
		return false;
	}
};

/**
 * Many people share the demo login, so its limits are per client address, not per account: every admin request made
 * with a demo token, and every sign-in attempt to the demo email.
 */
export const demoAdminRequestLimiter = createLimiter({
	name: "demo-admin-requests",
	rule: RATE_LIMITS.demoAdminRequestsPerIp,
	kind: "local",
	key: (req) => (bearerIsDemo(req) ? `demo:${ipKey(req.ip)}` : null),
});

export const demoAdminSignInLimiter = createLimiter({
	name: "demo-admin-sign-in",
	rule: RATE_LIMITS.demoAdminSignInsPerIp,
	kind: "shared",
	key: (req) => (isDemoAdminEmail(req.body?.email) ? `demo-login:${ipKey(req.ip)}` : null),
});
