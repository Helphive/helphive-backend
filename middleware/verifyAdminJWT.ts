import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import AdminModel, { Admin } from "../dal/models/admin.model";
import { JWT_ALGORITHMS } from "../controllers/user-controllers/utils/token.utils";
import { ADMIN_TOKEN_AUDIENCE, adminTokenSecret } from "../config/adminAuth";
import { activeSessionFor, signAdminAccessToken } from "../controllers/admin/adminSessions";
import { setActor } from "../lib/requestContext";
import log from "../lib/logger";

declare module "express" {
	interface Request {
		admin?: Admin;
		/** The session the access token belongs to; absent for tokens issued before sessions existed. */
		adminSessionId?: string;
	}
}

export { ADMIN_TOKEN_AUDIENCE, adminTokenSecret };

/** An admin who may sign in: not disabled, and holding one of the admin flags (as before roles existed). */
export const isActiveAdmin = (admin: Pick<Admin, "roles" | "disabled"> | null | undefined) =>
	!!admin && !admin.disabled && (!!admin.roles?.admin || !!admin.roles?.superAdmin);

/** Access token without a session (kept for callers that predate sessions). */
export const signAdminToken = (admin: Admin) => signAdminAccessToken(admin).token;

export type AdminAuthResult =
	| { ok: true; admin: Admin; sessionId?: string }
	| { ok: false; status: 401 | 500; message: string };

/**
 * Checks a bearer token: HS256, admin audience, unexpired; the admin exists, is active and the token version matches
 * (sign out everywhere raises it); and for tokens from a session, the session is still active.
 */
export const authenticateAdmin = (req: Request): Promise<AdminAuthResult> => {
	// Once per request: the demo guard and the route's own check share the result.
	const cached = req as Request & { adminAuth?: Promise<AdminAuthResult> };
	cached.adminAuth ??= authenticate(req);
	return cached.adminAuth;
};

const authenticate = async (req: Request): Promise<AdminAuthResult> => {
	const authHeader = req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return { ok: false, status: 401, message: "No token, authorization denied" };
	}
	const secret = adminTokenSecret();
	if (!secret) return { ok: false, status: 500, message: "Server error" };

	let decoded: any;
	try {
		decoded = jwt.verify(authHeader.slice(7), secret, {
			algorithms: JWT_ALGORITHMS,
			audience: ADMIN_TOKEN_AUDIENCE,
		});
	} catch {
		return { ok: false, status: 401, message: "Not authorized" };
	}
	const email = decoded?.UserInfo?.email;
	if (typeof email !== "string" || !email || typeof decoded?.tv !== "number") {
		return { ok: false, status: 401, message: "Not authorized" };
	}

	try {
		const admin = await AdminModel.findOne({ email }).exec();
		if (!admin || !isActiveAdmin(admin) || (admin.tokenVersion ?? 0) !== decoded.tv) {
			return { ok: false, status: 401, message: "Not authorized" };
		}
		if (decoded.sub !== undefined && decoded.sub !== String(admin._id)) {
			return { ok: false, status: 401, message: "Not authorized" };
		}
		if (decoded.sid !== undefined) {
			if (typeof decoded.sid !== "string" || !(await activeSessionFor(decoded.sid, admin._id, req))) {
				return { ok: false, status: 401, message: "Not authorized" };
			}
			return { ok: true, admin, sessionId: decoded.sid };
		}
		return { ok: true, admin };
	} catch (error) {
		log.error("Error verifying admin token", error);
		return { ok: false, status: 500, message: "Server error" };
	}
};

const accept = (req: Request, result: Extract<AdminAuthResult, { ok: true }>) => {
	req.admin = result.admin;
	req.adminSessionId = result.sessionId;
	setActor("admin", String(result.admin._id), req.context);
};

export const verifyAdminJWT = async (req: Request, res: Response, next: NextFunction) => {
	const result = await authenticateAdmin(req);
	if (!result.ok) return res.status(result.status).json({ message: result.message });
	accept(req, result);
	next();
};

/** Like verifyAdminJWT, but a request without a usable token continues without req.admin (sign-out by cookie). */
export const optionalAdminJWT = async (req: Request, _res: Response, next: NextFunction) => {
	const result = await authenticateAdmin(req);
	if (result.ok) accept(req, result);
	next();
};
