// Admin sessions: issuing access tokens, the refresh-token cookie, rotation and revocation. The pure parts (token
// format, rotation decision) are in lib/adminRefreshTokens.ts.
import type { CookieOptions, Request, Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import AdminModel, { type Admin } from "../../dal/models/admin.model";
import AdminSessionModel, { type AdminSessionDoc } from "../../dal/models/adminSession.model";
import {
	ADMIN_ACCESS_TOKEN_TTL_MS,
	ADMIN_COOKIE_PATH,
	ADMIN_REFRESH_COOKIE,
	ADMIN_SESSION_IDLE_TTL_MS,
	ADMIN_SESSION_TTL_MS,
	ADMIN_TOKEN_AUDIENCE,
	adminRefreshKey,
	adminTokenSecret,
} from "../../config/adminAuth";
import {
	decideRefresh,
	issueRefreshToken,
	parseRefreshToken,
	type RefreshDecision,
} from "../../lib/adminRefreshTokens";
import { effectiveRole, isDemoAdmin, permissionsFor } from "../../config/adminPermissions";

// Revoked and expired sessions stay listed for a week, then MongoDB's TTL monitor removes them.
const KEEP_AFTER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
// lastUsedAt is written at most this often from access-token use (each refresh always writes it).
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

export interface AccessTokenClaims {
	UserInfo: { email: string; roles: unknown[] };
	tv: number;
	sub?: string;
	sid?: string;
	/** Present on tokens of the public demo admin, so per-address limits apply without a database read. */
	demo?: true;
}

/**
 * Signs an access token. Claims as before ({ UserInfo: { email, roles }, tv }) plus `sub` (admin id) and, for
 * tokens from a session, `sid`. Tokens without `sid` (issued before sessions) keep working until they expire.
 */
export const signAdminAccessToken = (
	admin: Pick<Admin, "_id" | "email" | "roles" | "tokenVersion" | "role">,
	sessionId?: string,
) => {
	const expiresAt = new Date(Date.now() + ADMIN_ACCESS_TOKEN_TTL_MS);
	const claims: AccessTokenClaims = {
		UserInfo: { email: admin.email, roles: Object.values(admin.roles ?? {}).filter(Boolean) },
		tv: admin.tokenVersion ?? 0,
		sub: String(admin._id),
		...(sessionId ? { sid: sessionId } : {}),
		...(isDemoAdmin(admin) ? { demo: true as const } : {}),
	};
	const token = jwt.sign(claims, adminTokenSecret(), {
		expiresIn: Math.floor(ADMIN_ACCESS_TOKEN_TTL_MS / 1000),
		audience: ADMIN_TOKEN_AUDIENCE,
		algorithm: "HS256",
	});
	return { token, expiresAt };
};

export const refreshCookieOptions = (expires?: Date): CookieOptions => ({
	httpOnly: true,
	secure: true,
	sameSite: "strict",
	path: ADMIN_COOKIE_PATH,
	...(expires ? { expires } : {}),
});

export const setRefreshCookie = (res: Response, token: string, expires: Date) =>
	res.cookie(ADMIN_REFRESH_COOKIE, token, refreshCookieOptions(expires));

export const clearRefreshCookie = (res: Response) => res.clearCookie(ADMIN_REFRESH_COOKIE, refreshCookieOptions());

export const refreshCookieFrom = (req: Request): string | undefined => {
	const value = (req.cookies as Record<string, unknown> | undefined)?.[ADMIN_REFRESH_COOKIE];
	return typeof value === "string" ? value : undefined;
};

/** What a successful sign-in or refresh adds to its response, next to the existing fields. */
export const sessionResponseFields = (
	admin: Pick<Admin, "role" | "roles" | "mustChangePassword" | "email">,
	access: { expiresAt: Date },
	session?: { _id: mongoose.Types.ObjectId; expiresAt: Date },
) => {
	const role = effectiveRole(admin);
	return {
		accessTokenExpiresAt: access.expiresAt.toISOString(),
		...(session ? { sessionId: String(session._id), sessionExpiresAt: session.expiresAt.toISOString() } : {}),
		role,
		permissions: permissionsFor(role),
		mustChangePassword: !!admin.mustChangePassword,
		// The console shows a banner and disables actions for the public demo admin.
		demo: role === "demo",
	};
};

/** Starts a session for a signed-in admin: stores it, sets the refresh cookie and returns the access token. */
export const startAdminSession = async (req: Request, res: Response, admin: Admin, options: { mfa: boolean }) => {
	const now = new Date();
	const sessionId = new mongoose.Types.ObjectId();
	const refresh = issueRefreshToken(adminRefreshKey(), String(sessionId), 0);
	const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
	const session = await AdminSessionModel.create({
		_id: sessionId,
		adminId: admin._id,
		generation: 0,
		tokenHash: refresh.hash,
		createdAt: now,
		lastUsedAt: now,
		expiresAt,
		deleteAt: new Date(expiresAt.getTime() + KEEP_AFTER_EXPIRY_MS),
		ip: req.context?.ip,
		userAgent: req.context?.userAgent,
		lastIp: req.context?.ip,
		lastUserAgent: req.context?.userAgent,
		mfa: options.mfa,
	});
	setRefreshCookie(res, refresh.token, expiresAt);
	const access = signAdminAccessToken(admin, String(sessionId));
	return { session, access };
};

export type RefreshOutcome =
	| { ok: true; admin: Admin; session: AdminSessionDoc; access: { token: string; expiresAt: Date }; rotated: boolean }
	| {
			ok: false;
			decision: RefreshDecision["kind"] | "malformed" | "admin_inactive";
			session?: AdminSessionDoc | null;
	  };

/**
 * Exchanges the refresh cookie for a new access token, rotating the refresh token (new cookie). Reuse of an old token
 * revokes the session. `isActive` decides whether the admin may still sign in.
 */
export const refreshAdminSession = async (
	req: Request,
	res: Response,
	isActive: (admin: Admin) => boolean,
): Promise<RefreshOutcome> => {
	const key = adminRefreshKey();
	const parsed = parseRefreshToken(key, refreshCookieFrom(req));
	if (!parsed) return { ok: false, decision: "malformed" };

	for (let attempt = 0; attempt < 2; attempt++) {
		const now = new Date();
		const session = await AdminSessionModel.findById(parsed.sessionId).lean<AdminSessionDoc>().exec();
		const decision = decideRefresh(session, parsed, now, ADMIN_SESSION_IDLE_TTL_MS);
		if (decision.kind === "reuse" && session) {
			await revokeSessions({ _id: session._id }, "reuse_detected");
			return { ok: false, decision: "reuse", session };
		}
		if ((decision.kind !== "rotate" && decision.kind !== "grace") || !session) {
			return { ok: false, decision: decision.kind, session };
		}

		const admin = await AdminModel.findById(session.adminId).exec();
		if (!admin || !isActive(admin)) {
			await revokeSessions({ _id: session._id }, "admin_disabled");
			return { ok: false, decision: "admin_inactive", session };
		}

		if (decision.kind === "grace") {
			// The other tab already rotated; this response sets no cookie, so the browser keeps the newer one.
			return {
				ok: true,
				admin,
				session,
				access: signAdminAccessToken(admin, String(session._id)),
				rotated: false,
			};
		}

		const next = issueRefreshToken(key, String(session._id), session.generation + 1);
		const updated = await AdminSessionModel.findOneAndUpdate(
			{ _id: session._id, generation: session.generation, tokenHash: session.tokenHash, revokedAt: null },
			{
				$set: {
					generation: session.generation + 1,
					tokenHash: next.hash,
					previousTokenHash: session.tokenHash,
					rotatedAt: now,
					lastUsedAt: now,
					lastIp: req.context?.ip,
					lastUserAgent: req.context?.userAgent,
				},
			},
			{ new: true },
		)
			.lean<AdminSessionDoc>()
			.exec();
		// Lost a race with another refresh of the same token: decide again against the new state (grace).
		if (!updated) continue;
		setRefreshCookie(res, next.token, updated.expiresAt);
		return {
			ok: true,
			admin,
			session: updated,
			access: signAdminAccessToken(admin, String(updated._id)),
			rotated: true,
		};
	}
	return { ok: false, decision: "invalid" };
};

/** Revokes every matching session that is still active. Returns how many. */
export const revokeSessions = async (filter: Record<string, unknown>, reason: AdminSessionDoc["revokedReason"]) => {
	const result = await AdminSessionModel.updateMany(
		{ ...filter, revokedAt: null },
		{ $set: { revokedAt: new Date(), revokedReason: reason } },
	).exec();
	return result.modifiedCount;
};

/** Ends every session of an admin and every token issued before now (tokens carry the token version). */
export const signOutEverywhere = async (
	adminId: mongoose.Types.ObjectId | string,
	reason: AdminSessionDoc["revokedReason"],
) => {
	await AdminModel.updateOne({ _id: adminId }, { $inc: { tokenVersion: 1 } }).exec();
	return revokeSessions({ adminId: new mongoose.Types.ObjectId(String(adminId)) }, reason);
};

/** The session an access token names, if it is still usable; also notes the use (at most once a minute). */
export const activeSessionFor = async (sessionId: string, adminId: mongoose.Types.ObjectId, req: Request) => {
	if (!/^[a-f\d]{24}$/i.test(sessionId)) return null;
	const session = await AdminSessionModel.findById(sessionId).lean<AdminSessionDoc>().exec();
	const now = Date.now();
	if (!session || !session.adminId.equals(adminId) || session.revokedAt || session.expiresAt.getTime() <= now)
		return null;
	if (now - session.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
		AdminSessionModel.updateOne(
			{ _id: session._id },
			{ $set: { lastUsedAt: new Date(now), lastIp: req.context?.ip, lastUserAgent: req.context?.userAgent } },
		)
			.exec()
			.catch(() => undefined);
	}
	return session;
};

/** A session as the console shows it. */
export const publicSession = (session: AdminSessionDoc, currentSessionId?: string) => ({
	id: String(session._id),
	createdAt: session.createdAt,
	lastUsedAt: session.lastUsedAt,
	expiresAt: session.expiresAt,
	ip: session.ip ?? null,
	userAgent: session.userAgent ?? null,
	lastIp: session.lastIp ?? null,
	lastUserAgent: session.lastUserAgent ?? null,
	mfa: !!session.mfa,
	current: String(session._id) === currentSessionId,
});
