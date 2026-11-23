// Admin sign-in, two-step completion, refresh, sign-out, sessions, own account and password.
import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { validationResult } from "express-validator";
import mongoose from "mongoose";
import AdminModel, { type Admin } from "../../dal/models/admin.model";
import AdminSessionModel, { type AdminSessionDoc } from "../../dal/models/adminSession.model";
import {
	ADMIN_MFA_AUDIENCE,
	ADMIN_MFA_CHALLENGE_TTL_SECONDS,
	adminRefreshKey,
	adminTokenSecret,
	isAdminOrigin,
} from "../../config/adminAuth";
import {
	effectiveRole,
	isDemoAdmin,
	permissionsFor,
	PERMISSIONS,
	ROLE_LABELS,
	ROLE_PERMISSIONS,
	ADMIN_ROLES,
} from "../../config/adminPermissions";
import { isActiveAdmin } from "../../middleware/verifyAdminJWT";
import { publicValidationErrors } from "../../middleware/sanitizeInput";
import { recordSuccessfulSignIn } from "../../middleware/rateLimit";
import { isDemoAdminEmail } from "../../config/demoAccounts";
import { JWT_ALGORITHMS } from "../user-controllers/utils/token.utils";
import { adminActor, recordAudit } from "../../lib/audit";
import { parseRefreshToken } from "../../lib/adminRefreshTokens";
import log from "../../lib/logger";
import {
	clearRefreshCookie,
	publicSession,
	refreshAdminSession,
	refreshCookieFrom,
	revokeSessions,
	sessionResponseFields,
	signAdminAccessToken,
	signOutEverywhere,
	startAdminSession,
} from "./adminSessions";
import { verifySecondFactor } from "./adminMfa";

export const ADMIN_BCRYPT_ROUNDS = 12;
const DUMMY_ADMIN_HASH = bcrypt.hashSync("helphive-dummy-admin-password", ADMIN_BCRYPT_ROUNDS);
const INVALID_CREDENTIALS = { message: "Invalid credentials" };
const CODE_REFUSED = { message: "That code is not correct or has already been used." };

/** Completes a sign-in: session, cookie, access token, records. Response keeps { admin, accessToken } and adds fields. */
const completeSignIn = async (req: Request, res: Response, admin: Admin, mfa: boolean) => {
	const { session, access } = await startAdminSession(req, res, admin, { mfa });
	await AdminModel.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } }).exec();
	recordSuccessfulSignIn("admin", req, admin.email);
	await recordAudit(
		{
			action: "auth.login.succeeded",
			actor: { type: "admin", id: admin._id, email: admin.email },
			target: { type: "admin", id: admin._id },
			metadata: { sessionId: String(session._id), mfa },
			demo: isDemoAdmin(admin),
		},
		req,
	);
	res.json({ admin, accessToken: access.token, ...sessionResponseFields(admin, access, session) });
};

const signMfaChallenge = (admin: Admin) => {
	const expiresAt = new Date(Date.now() + ADMIN_MFA_CHALLENGE_TTL_SECONDS * 1000);
	const challengeToken = jwt.sign({ tv: admin.tokenVersion ?? 0 }, adminTokenSecret(), {
		subject: String(admin._id),
		audience: ADMIN_MFA_AUDIENCE,
		expiresIn: ADMIN_MFA_CHALLENGE_TTL_SECONDS,
		algorithm: "HS256",
		jwtid: new mongoose.Types.ObjectId().toString(),
	});
	return { challengeToken, challengeExpiresAt: expiresAt.toISOString() };
};

/**
 * POST /admin/login. Without two-step sign-in: { admin, accessToken, ...new fields } and the refresh cookie, as before.
 * With it: { mfaRequired: true, challengeToken, challengeExpiresAt, methods } and no tokens.
 */
export const handleLogin = async (req: Request, res: Response) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Email and password are required.",
				errors: publicValidationErrors(errors),
			});
		}
		const { email, password } = req.body;

		// Same response and the same bcrypt work whether or not the admin exists.
		const admin = await AdminModel.findOne({ email });
		const passwordMatch = await bcrypt.compare(password, admin?.password ?? DUMMY_ADMIN_HASH);
		const temporaryExpired =
			!!admin?.mustChangePassword &&
			!!admin.temporaryPasswordExpiresAt &&
			admin.temporaryPasswordExpiresAt.getTime() <= Date.now();
		if (!admin || !passwordMatch || !isActiveAdmin(admin) || temporaryExpired) {
			const reason = !admin
				? "unknown_email"
				: !passwordMatch
					? "wrong_password"
					: temporaryExpired
						? "temporary_password_expired"
						: "admin_disabled";
			await recordAudit(
				{
					action: "auth.login.failed",
					outcome: "failure",
					actor: admin ? { type: "admin", id: admin._id, email: admin.email } : { type: "anonymous", email },
					target: admin ? { type: "admin", id: admin._id } : null,
					metadata: { reason },
					demo: isDemoAdminEmail(email),
				},
				req,
			);
			return res.status(401).json(INVALID_CREDENTIALS);
		}

		if (admin.mfa?.enabled) {
			await recordAudit(
				{
					action: "auth.login.mfa_required",
					actor: { type: "admin", id: admin._id, email: admin.email },
					target: { type: "admin", id: admin._id },
				},
				req,
			);
			return res.json({ mfaRequired: true, ...signMfaChallenge(admin), methods: ["totp", "recovery_code"] });
		}

		await completeSignIn(req, res, admin, false);
	} catch (error) {
		log.error("admin_login_failed", "Error logging in admin", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** POST /admin/login/mfa { challengeToken, code | recoveryCode }: the second step. */
export const handleLoginMfa = async (req: Request, res: Response) => {
	try {
		let decoded: any;
		try {
			decoded = jwt.verify(req.body.challengeToken, adminTokenSecret(), {
				algorithms: JWT_ALGORITHMS,
				audience: ADMIN_MFA_AUDIENCE,
			});
		} catch {
			return res.status(401).json({ message: "The sign-in step has expired. Sign in again." });
		}
		const admin =
			typeof decoded?.sub === "string" && /^[a-f\d]{24}$/i.test(decoded.sub)
				? await AdminModel.findById(decoded.sub).exec()
				: null;
		if (!admin || !isActiveAdmin(admin) || (admin.tokenVersion ?? 0) !== decoded.tv || !admin.mfa?.enabled) {
			return res.status(401).json({ message: "The sign-in step has expired. Sign in again." });
		}

		const result = await verifySecondFactor(admin, req.body);
		if (!result.ok) {
			await recordAudit(
				{
					action: "auth.login.mfa_failed",
					outcome: "failure",
					actor: { type: "admin", id: admin._id, email: admin.email },
					target: { type: "admin", id: admin._id },
					metadata: { method: req.body.recoveryCode ? "recovery_code" : "totp" },
				},
				req,
			);
			return res.status(401).json(CODE_REFUSED);
		}
		if (result.method === "recovery") {
			await recordAudit(
				{
					action: "account.mfa.recovery_code_used",
					actor: { type: "admin", id: admin._id, email: admin.email },
					target: { type: "admin", id: admin._id },
					metadata: { remaining: result.remainingRecoveryCodes },
				},
				req,
			);
		}
		await completeSignIn(req, res, admin, true);
	} catch (error) {
		log.error("admin_two_step_login_failed", "Error completing admin two-step sign-in", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** Browsers send Origin on cross-origin POSTs; a cookie-authenticated call from anywhere but the console is refused. */
const originAllowed = (req: Request) => isAdminOrigin(req.headers.origin);

/** POST /admin/refresh: new access token from the refresh cookie (rotated). 401 and the cookie cleared otherwise. */
export const handleRefresh = async (req: Request, res: Response) => {
	if (!originAllowed(req)) return res.status(403).json({ message: "Origin not allowed." });
	try {
		const outcome = await refreshAdminSession(req, res, (admin) => isActiveAdmin(admin));
		if (!outcome.ok) {
			if (outcome.decision === "reuse" && outcome.session) {
				const owner = await AdminModel.findById(outcome.session.adminId).select("email").lean().exec();
				await recordAudit(
					{
						action: "auth.session.reuse_detected",
						outcome: "failure",
						actor: { type: "admin", id: outcome.session.adminId, email: owner?.email ?? null },
						target: { type: "admin_session", id: outcome.session._id },
					},
					req,
				);
				log.warn("admin_refresh_token_reuse", "Admin refresh token reuse detected; session revoked", {
					sessionId: String(outcome.session._id),
				});
			}
			clearRefreshCookie(res);
			return res.status(401).json({ message: "Your session has ended. Sign in again." });
		}
		const { admin, access, session } = outcome;
		res.json({ admin, accessToken: access.token, ...sessionResponseFields(admin, access, session) });
	} catch (error) {
		log.error("refreshing_admin_session_failed", "Error refreshing admin session", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/**
 * POST /admin/logout. With a token from a session: ends that session. With an older token (no session): signs this
 * admin out everywhere, as before. Without a usable token, the refresh cookie alone ends its session.
 */
export const handleLogout = async (req: Request, res: Response) => {
	try {
		if (req.admin) {
			if (req.adminSessionId) {
				await revokeSessions({ _id: new mongoose.Types.ObjectId(req.adminSessionId) }, "logout");
			} else if (!isDemoAdmin(req.admin)) {
				// Older tokens have no session, so signing out ends them all. Never for the shared demo login, where
				// that would sign out every visitor.
				await AdminModel.updateOne({ _id: req.admin._id }, { $inc: { tokenVersion: 1 } });
			}
			clearRefreshCookie(res);
			await recordAudit(
				{
					action: "auth.logout",
					actor: adminActor(req),
					target: { type: "admin_session", id: req.adminSessionId ?? null },
					metadata: req.adminSessionId ? undefined : { allTokens: !isDemoAdmin(req.admin) },
					demo: isDemoAdmin(req.admin),
				},
				req,
			);
			return res.sendStatus(204);
		}
		const parsed = parseRefreshToken(adminRefreshKey(), refreshCookieFrom(req));
		if (parsed && originAllowed(req)) {
			const session = await AdminSessionModel.findById(parsed.sessionId).lean<AdminSessionDoc>().exec();
			if (session) {
				await revokeSessions({ _id: session._id }, "logout");
				const owner = await AdminModel.findById(session.adminId).select("email").lean().exec();
				await recordAudit(
					{
						action: "auth.logout",
						actor: { type: "admin", id: session.adminId, email: owner?.email ?? null },
						target: { type: "admin_session", id: session._id },
						metadata: { via: "cookie" },
					},
					req,
				);
			}
			clearRefreshCookie(res);
			return res.sendStatus(204);
		}
		return res.status(401).json({ message: "No token, authorization denied" });
	} catch (error) {
		log.error("logging_out_admin_failed", "Error logging out admin", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** POST /admin/logout-all: every session of this admin, and every token issued so far. */
export const handleLogoutAll = async (req: Request, res: Response) => {
	try {
		const admin = req.admin as Admin;
		const sessions = await signOutEverywhere(admin._id, "logout_all");
		clearRefreshCookie(res);
		await recordAudit(
			{
				action: "auth.logout_all",
				actor: adminActor(req),
				target: { type: "admin", id: admin._id },
				metadata: { sessions },
			},
			req,
		);
		res.sendStatus(204);
	} catch (error) {
		log.error("admin_sign_out_everywhere_failed", "Error signing admin out everywhere", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** GET /admin/account: { user } as before, plus role, permissions and the current session id. */
export const handleGetAccount = async (req: Request, res: Response) => {
	try {
		const admin = req.admin as Admin;
		const role = effectiveRole(admin);
		res.json({
			user: admin,
			role,
			roleLabel: ROLE_LABELS[role],
			permissions: permissionsFor(role),
			sessionId: req.adminSessionId ?? null,
			demo: role === "demo",
		});
	} catch (error) {
		log.error("getting_admin_account_failed", "Error getting admin account", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** GET /admin/roles: the role and permission table, for the console's labels and admin management screens. */
export const handleGetRoles = (_req: Request, res: Response) => {
	res.json({
		roles: ADMIN_ROLES.map((role) => ({ role, label: ROLE_LABELS[role], permissions: ROLE_PERMISSIONS[role] })),
		permissions: PERMISSIONS,
	});
};

/** GET /admin/sessions: this admin's active sessions, most recently used first. */
export const handleListSessions = async (req: Request, res: Response) => {
	try {
		const sessions = await AdminSessionModel.find({
			adminId: (req.admin as Admin)._id,
			revokedAt: null,
			expiresAt: { $gt: new Date() },
		})
			.sort({ lastUsedAt: -1 })
			.limit(100)
			.lean<AdminSessionDoc[]>()
			.exec();
		res.json({ items: sessions.map((session) => publicSession(session, req.adminSessionId)) });
	} catch (error) {
		log.error("listing_admin_sessions_failed", "Error listing admin sessions", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** DELETE /admin/sessions/:id: ends one of this admin's sessions. */
export const handleRevokeSession = async (req: Request, res: Response) => {
	try {
		const admin = req.admin as Admin;
		const revoked = await revokeSessions(
			{ _id: new mongoose.Types.ObjectId(req.params.id), adminId: admin._id },
			"revoked_by_self",
		);
		if (!revoked) return res.status(404).json({ message: "Session not found." });
		if (req.params.id === req.adminSessionId) clearRefreshCookie(res);
		await recordAudit(
			{
				action: "auth.session.revoked",
				actor: adminActor(req),
				target: { type: "admin_session", id: req.params.id },
			},
			req,
		);
		res.sendStatus(204);
	} catch (error) {
		log.error("revoking_admin_session_failed", "Error revoking admin session", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/**
 * POST /admin/change-password { currentPassword, newPassword }: same policy as user passwords. Other sessions and all
 * older tokens end; the response carries a fresh access token for this session.
 */
export const handleChangePassword = async (req: Request, res: Response) => {
	try {
		const admin = await AdminModel.findById((req.admin as Admin)._id).exec();
		if (!admin) return res.status(401).json({ message: "Not authorized" });
		const { currentPassword, newPassword } = req.body;
		if (!(await bcrypt.compare(currentPassword, admin.password))) {
			return res.status(400).json({ message: "Your current password is not correct." });
		}
		if (await bcrypt.compare(newPassword, admin.password)) {
			return res.status(400).json({ message: "Choose a password different from your current one." });
		}
		const hash = await bcrypt.hash(newPassword, ADMIN_BCRYPT_ROUNDS);
		const updated = await AdminModel.findOneAndUpdate(
			{ _id: admin._id },
			{
				$set: {
					password: hash,
					mustChangePassword: false,
					temporaryPasswordExpiresAt: null,
					passwordChangedAt: new Date(),
				},
				$inc: { tokenVersion: 1 },
			},
			{ new: true },
		).exec();
		if (!updated) return res.status(401).json({ message: "Not authorized" });

		const keep = req.adminSessionId ? { _id: { $ne: new mongoose.Types.ObjectId(req.adminSessionId) } } : {};
		const ended = await revokeSessions({ adminId: admin._id, ...keep }, "password_changed");

		let access: { token: string; expiresAt: Date };
		let session: { _id: mongoose.Types.ObjectId; expiresAt: Date } | undefined;
		if (req.adminSessionId) {
			access = signAdminAccessToken(updated, req.adminSessionId);
			session =
				(await AdminSessionModel.findById(req.adminSessionId).select("_id expiresAt").lean().exec()) ??
				undefined;
		} else {
			({ access, session } = await startAdminSession(req, res, updated, { mfa: false }));
		}
		await recordAudit(
			{
				action: "account.password.changed",
				actor: adminActor(req),
				target: { type: "admin", id: admin._id },
				metadata: { otherSessionsEnded: ended, wasOneTimePassword: !!admin.mustChangePassword },
			},
			req,
		);
		res.json({
			message: "Password changed.",
			accessToken: access.token,
			...sessionResponseFields(updated, access, session),
		});
	} catch (error) {
		log.error("changing_admin_password_failed", "Error changing admin password", error);
		res.status(500).json({ message: "Internal server error" });
	}
};
