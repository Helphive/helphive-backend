// Admin management (permission admins.manage): list, create with a one-time password, change role, disable and
// enable, sign out, reset two-step sign-in. The last active super admin can never be disabled or demoted.
import crypto from "crypto";
import { Request, Response } from "express";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import AdminModel, { type Admin } from "../../dal/models/admin.model";
import { ADMIN_TEMP_PASSWORD_TTL_MS } from "../../config/adminAuth";
import { effectiveRole, legacyFlagsFor, ROLE_LABELS, type AdminRole } from "../../config/adminPermissions";
import { adminActor, recordAudit } from "../../lib/audit";
import { ListQueryError, parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import log from "../../lib/logger";
import { isActiveAdmin } from "../../middleware/verifyAdminJWT";
import { ADMIN_BCRYPT_ROUNDS } from "./auth.controller";
import { signOutEverywhere } from "./adminSessions";

/** Mongo filter for admins who are active super admins (role field, or the legacy flag on role-less documents). */
export const ACTIVE_SUPER_ADMIN_FILTER = {
	disabled: { $ne: true },
	$and: [
		{ $or: [{ "roles.admin": true }, { "roles.superAdmin": true }] },
		{ $or: [{ role: "superAdmin" }, { role: { $exists: false }, "roles.superAdmin": true }] },
	],
};

/**
 * Whether a change would leave no active super admin. `target` is the admin being changed; `othersActive` is how many
 * other active super admins there are.
 */
export const wouldRemoveLastSuperAdmin = (
	target: Pick<Admin, "role" | "roles" | "disabled">,
	change: { disable?: boolean; role?: AdminRole },
	othersActive: number,
) => {
	const targetIsActiveSuper = isActiveAdmin(target) && effectiveRole(target) === "superAdmin";
	if (!targetIsActiveSuper || othersActive > 0) return false;
	return !!change.disable || (change.role !== undefined && change.role !== "superAdmin");
};

const othersActiveSuperAdmins = (excludeId: mongoose.Types.ObjectId) =>
	AdminModel.countDocuments({ ...ACTIVE_SUPER_ADMIN_FILTER, _id: { $ne: excludeId } }).exec();

const LAST_SUPER_ADMIN = { message: "This is the last active super admin. Make another admin a super admin first." };

/** An admin as the management screens show it. */
export const publicAdmin = (admin: any) => {
	const role = effectiveRole(admin);
	return {
		_id: String(admin._id),
		firstName: admin.firstName,
		lastName: admin.lastName,
		email: admin.email,
		role,
		roleLabel: ROLE_LABELS[role],
		roleIsLegacy: !admin.role,
		disabled: !!admin.disabled,
		disabledAt: admin.disabledAt ?? null,
		mfaEnabled: !!admin.mfa?.enabled,
		mustChangePassword: !!admin.mustChangePassword,
		lastLoginAt: admin.lastLoginAt ?? null,
		createdAt: admin.createdAt ?? null,
	};
};

const roleFilter = (value: string) => {
	if (value === "superAdmin")
		return { $or: [{ role: "superAdmin" }, { role: { $exists: false }, "roles.superAdmin": true }] };
	if (value === "operations") {
		return { $or: [{ role: "operations" }, { role: { $exists: false }, "roles.superAdmin": { $ne: true } }] };
	}
	if (["finance", "support", "analyst"].includes(value)) return { role: value };
	return null;
};

export const ADMIN_LIST_SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", email: "email", lastLoginAt: "lastLoginAt", lastName: "lastName" },
	defaultSort: "-createdAt",
	filters: {
		role: { type: "custom", parse: roleFilter },
		status: {
			type: "custom",
			parse: (value) =>
				value === "active" ? { disabled: { $ne: true } } : value === "disabled" ? { disabled: true } : null,
		},
	},
	dateField: "createdAt",
	searchFields: ["email", "firstName", "lastName"],
	maxPageSize: 100,
};

const ADMIN_LIST_PROJECTION =
	"firstName lastName email role roles disabled disabledAt mustChangePassword lastLoginAt createdAt mfa.enabled";

/** GET /admin/admins */
export const handleListAdmins = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query as Record<string, unknown>, ADMIN_LIST_SPEC);
		res.json(await runListQuery(AdminModel, parsed, { projection: ADMIN_LIST_PROJECTION, map: publicAdmin }));
	} catch (error) {
		if (error instanceof ListQueryError)
			return res.status(400).json({ message: error.message, field: error.field });
		log.error("listing_admins_failed", "Error listing admins", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

const findTarget = (id: string) => AdminModel.findById(id).exec();

/** GET /admin/admins/:id */
export const handleGetAdmin = async (req: Request, res: Response) => {
	try {
		const admin = await findTarget(req.params.id);
		if (!admin) return res.status(404).json({ message: "Admin not found." });
		res.json({ admin: publicAdmin(admin) });
	} catch (error) {
		log.error("getting_admin_failed", "Error getting admin", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";

/** A 20-character one-time password meeting the user password policy (one of each class, the rest mixed). */
export const generateTemporaryPassword = () => {
	const all = UPPER + LOWER + DIGITS + SYMBOLS;
	const pick = (set: string) => set[crypto.randomInt(set.length)];
	const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
	while (chars.length < 20) chars.push(pick(all));
	for (let i = chars.length - 1; i > 0; i--) {
		const j = crypto.randomInt(i + 1);
		[chars[i], chars[j]] = [chars[j], chars[i]];
	}
	return chars.join("");
};

/**
 * POST /admin/admins { firstName, lastName, email, role }: creates an admin with a server-generated one-time password,
 * returned once. They must change it at first sign-in, within ADMIN_TEMP_PASSWORD_TTL (default 72 hours).
 */
export const handleCreateAdmin = async (req: Request, res: Response) => {
	try {
		const { firstName, lastName, role } = req.body as { firstName: string; lastName: string; role: AdminRole };
		const email = String(req.body.email).trim();
		if (await AdminModel.exists({ email })) return res.status(409).json({ message: "Admin already exists" });

		const temporaryPassword = generateTemporaryPassword();
		const temporaryPasswordExpiresAt = new Date(Date.now() + ADMIN_TEMP_PASSWORD_TTL_MS);
		const created = await AdminModel.create({
			firstName,
			lastName,
			email,
			password: await bcrypt.hash(temporaryPassword, ADMIN_BCRYPT_ROUNDS),
			role,
			roles: legacyFlagsFor(role),
			mustChangePassword: true,
			temporaryPasswordExpiresAt,
			createdBy: (req.admin as Admin)._id,
		});
		await recordAudit(
			{
				action: "admins.created",
				actor: adminActor(req),
				target: { type: "admin", id: created._id },
				after: { email, firstName, lastName, role },
			},
			req,
		);
		res.status(201).json({
			admin: publicAdmin(created),
			temporaryPassword,
			temporaryPasswordExpiresAt: temporaryPasswordExpiresAt.toISOString(),
		});
	} catch (error: any) {
		if (error?.code === 11000) return res.status(409).json({ message: "Admin already exists" });
		log.error("creating_admin_failed", "Error creating admin", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

const notSelf = (req: Request, res: Response) => {
	// Ids are hexadecimal and MongoDB matches them in either case, so compare without regard to case.
	if (String(req.params.id).toLowerCase() === String((req.admin as Admin)._id).toLowerCase()) {
		res.status(400).json({ message: "Ask another admin to make this change to your own account." });
		return false;
	}
	return true;
};

/** PATCH /admin/admins/:id/role { role, reason? } */
export const handleChangeAdminRole = async (req: Request, res: Response) => {
	try {
		if (!notSelf(req, res)) return;
		const target = await findTarget(req.params.id);
		if (!target) return res.status(404).json({ message: "Admin not found." });
		const role = req.body.role as AdminRole;
		const before = effectiveRole(target);
		if (before === role && target.role === role) return res.json({ admin: publicAdmin(target) });
		if (wouldRemoveLastSuperAdmin(target, { role }, await othersActiveSuperAdmins(target._id))) {
			return res.status(409).json(LAST_SUPER_ADMIN);
		}
		const updated = await AdminModel.findOneAndUpdate(
			{ _id: target._id },
			{ $set: { role, roles: legacyFlagsFor(role), updatedAt: new Date() } },
			{ new: true },
		).exec();
		// Two super admins demoting each other at once could both pass the check above; undo if none is left.
		if (
			before === "superAdmin" &&
			role !== "superAdmin" &&
			(await AdminModel.countDocuments(ACTIVE_SUPER_ADMIN_FILTER)) === 0
		) {
			await AdminModel.updateOne(
				{ _id: target._id },
				{ $set: { role: "superAdmin", roles: legacyFlagsFor("superAdmin") } },
			);
			return res.status(409).json(LAST_SUPER_ADMIN);
		}
		await recordAudit(
			{
				action: "admins.role_changed",
				actor: adminActor(req),
				target: { type: "admin", id: target._id },
				before: { role: before },
				after: { role },
				reason: req.body.reason,
			},
			req,
		);
		res.json({ admin: publicAdmin(updated) });
	} catch (error) {
		log.error("changing_admin_role_failed", "Error changing admin role", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** POST /admin/admins/:id/disable { reason }: the admin can no longer sign in; every session ends. */
export const handleDisableAdmin = async (req: Request, res: Response) => {
	try {
		if (!notSelf(req, res)) return;
		const target = await findTarget(req.params.id);
		if (!target) return res.status(404).json({ message: "Admin not found." });
		if (target.disabled) return res.json({ admin: publicAdmin(target) });
		if (wouldRemoveLastSuperAdmin(target, { disable: true }, await othersActiveSuperAdmins(target._id))) {
			return res.status(409).json(LAST_SUPER_ADMIN);
		}
		await AdminModel.updateOne(
			{ _id: target._id },
			{ $set: { disabled: true, disabledAt: new Date(), updatedAt: new Date() } },
		);
		if (
			effectiveRole(target) === "superAdmin" &&
			(await AdminModel.countDocuments(ACTIVE_SUPER_ADMIN_FILTER)) === 0
		) {
			await AdminModel.updateOne({ _id: target._id }, { $set: { disabled: false, disabledAt: null } });
			return res.status(409).json(LAST_SUPER_ADMIN);
		}
		const sessions = await signOutEverywhere(target._id, "admin_disabled");
		await recordAudit(
			{
				action: "admins.disabled",
				actor: adminActor(req),
				target: { type: "admin", id: target._id },
				before: { disabled: false },
				after: { disabled: true },
				reason: req.body.reason,
				metadata: { sessionsEnded: sessions },
			},
			req,
		);
		res.json({ admin: publicAdmin(await findTarget(req.params.id)) });
	} catch (error) {
		log.error("disabling_admin_failed", "Error disabling admin", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** POST /admin/admins/:id/enable { reason? } */
export const handleEnableAdmin = async (req: Request, res: Response) => {
	try {
		const target = await findTarget(req.params.id);
		if (!target) return res.status(404).json({ message: "Admin not found." });
		if (!target.disabled) return res.json({ admin: publicAdmin(target) });
		const updated = await AdminModel.findOneAndUpdate(
			{ _id: target._id },
			{ $set: { disabled: false, disabledAt: null, updatedAt: new Date() } },
			{ new: true },
		).exec();
		await recordAudit(
			{
				action: "admins.enabled",
				actor: adminActor(req),
				target: { type: "admin", id: target._id },
				before: { disabled: true },
				after: { disabled: false },
				reason: req.body?.reason,
			},
			req,
		);
		res.json({ admin: publicAdmin(updated) });
	} catch (error) {
		log.error("enabling_admin_failed", "Error enabling admin", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** POST /admin/admins/:id/sign-out { reason? }: ends every session and token of that admin. */
export const handleForceSignOut = async (req: Request, res: Response) => {
	try {
		const target = await findTarget(req.params.id);
		if (!target) return res.status(404).json({ message: "Admin not found." });
		const sessions = await signOutEverywhere(target._id, "forced_sign_out");
		await recordAudit(
			{
				action: "admins.signed_out",
				actor: adminActor(req),
				target: { type: "admin", id: target._id },
				reason: req.body?.reason,
				metadata: { sessionsEnded: sessions },
			},
			req,
		);
		res.json({ sessionsEnded: sessions });
	} catch (error) {
		log.error("admin_sign_out_failed", "Error signing admin out", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/**
 * POST /admin/admins/:id/reset-mfa { reason }: turns off another admin's two-step sign-in (lost device). They sign in
 * with their password and can enrol again. Their sessions are left alone.
 */
export const handleResetAdminMfa = async (req: Request, res: Response) => {
	try {
		if (!notSelf(req, res)) return;
		const target = await findTarget(req.params.id);
		if (!target) return res.status(404).json({ message: "Admin not found." });
		const wasEnabled = !!target.mfa?.enabled;
		await AdminModel.updateOne(
			{ _id: target._id },
			{
				$set: {
					"mfa.enabled": false,
					"mfa.secret": null,
					"mfa.pendingSecret": null,
					"mfa.pendingCreatedAt": null,
					"mfa.enabledAt": null,
					"mfa.lastUsedStep": null,
					"mfa.recoveryCodes": [],
				},
			},
		);
		await recordAudit(
			{
				action: "admins.mfa_reset",
				actor: adminActor(req),
				target: { type: "admin", id: target._id },
				before: { mfaEnabled: wasEnabled },
				after: { mfaEnabled: false },
				reason: req.body.reason,
			},
			req,
		);
		res.json({ admin: publicAdmin(await findTarget(req.params.id)) });
	} catch (error) {
		log.error("admin_two_step_reset_failed", "Error resetting admin two-step sign-in", error);
		res.status(500).json({ message: "Internal server error" });
	}
};
