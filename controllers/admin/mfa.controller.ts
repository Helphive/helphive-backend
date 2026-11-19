// Two-step sign-in for the signed-in admin: enrol, confirm, disable, replace recovery codes.
import { Request, Response } from "express";
import AdminModel, { type Admin } from "../../dal/models/admin.model";
import { ADMIN_MFA_ENROLLMENT_TTL_MS } from "../../config/adminAuth";
import { adminActor, recordAudit } from "../../lib/audit";
import { seal } from "../../lib/secretBox";
import {
	generateRecoveryCodes,
	generateTotpSecret,
	hashRecoveryCode,
	otpauthUri,
	verifyTotp,
	base32Decode,
} from "../../lib/totp";
import { open } from "../../lib/secretBox";
import log from "../../lib/logger";
import { mfaKeys, verifySecondFactor } from "./adminMfa";

const CODE_REFUSED = { message: "That code is not correct or has already been used." };

const newRecoveryCodes = () => {
	const codes = generateRecoveryCodes();
	const { recoveryKey } = mfaKeys();
	return { codes, stored: codes.map((code) => ({ hash: hashRecoveryCode(code, recoveryKey), usedAt: null })) };
};

const reload = (req: Request) => AdminModel.findById((req.admin as Admin)._id).exec();

/** GET /admin/mfa: whether two-step sign-in is on and how many recovery codes are left. */
export const handleGetMfa = async (req: Request, res: Response) => {
	const admin = req.admin as Admin;
	const mfa = admin.mfa;
	res.json({
		enabled: !!mfa?.enabled,
		enabledAt: mfa?.enabledAt ?? null,
		recoveryCodesRemaining: (mfa?.recoveryCodes ?? []).filter((code) => !code.usedAt).length,
		enrollmentPending:
			!mfa?.enabled &&
			!!mfa?.pendingSecret &&
			!!mfa.pendingCreatedAt &&
			Date.now() - mfa.pendingCreatedAt.getTime() < ADMIN_MFA_ENROLLMENT_TTL_MS,
	});
};

/** POST /admin/mfa/enroll: a new secret to add to an authenticator app. Not active until confirmed. */
export const handleEnrollMfa = async (req: Request, res: Response) => {
	try {
		const admin = req.admin as Admin;
		if (admin.mfa?.enabled) return res.status(409).json({ message: "Two-step sign-in is already on." });
		const secret = generateTotpSecret();
		await AdminModel.updateOne(
			{ _id: admin._id, "mfa.enabled": { $ne: true } },
			{ $set: { "mfa.pendingSecret": seal(secret, mfaKeys().secretKey), "mfa.pendingCreatedAt": new Date() } },
		).exec();
		await recordAudit(
			{
				action: "account.mfa.enrollment_started",
				actor: adminActor(req),
				target: { type: "admin", id: admin._id },
			},
			req,
		);
		res.json({
			secret,
			otpauthUri: otpauthUri(secret, admin.email),
			expiresAt: new Date(Date.now() + ADMIN_MFA_ENROLLMENT_TTL_MS).toISOString(),
		});
	} catch (error) {
		log.error("Error starting two-step enrolment", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** POST /admin/mfa/confirm { code }: turns two-step sign-in on and returns ten recovery codes (shown once). */
export const handleConfirmMfa = async (req: Request, res: Response) => {
	try {
		const admin = await reload(req);
		if (!admin) return res.status(401).json({ message: "Not authorized" });
		if (admin.mfa?.enabled) return res.status(409).json({ message: "Two-step sign-in is already on." });
		const pending = admin.mfa?.pendingSecret;
		const fresh =
			!!pending &&
			!!admin.mfa?.pendingCreatedAt &&
			Date.now() - admin.mfa.pendingCreatedAt.getTime() < ADMIN_MFA_ENROLLMENT_TTL_MS;
		if (!pending || !fresh) return res.status(400).json({ message: "Start the set-up again; it has expired." });

		const secret = base32Decode(open(pending, mfaKeys().secretKey));
		const step = verifyTotp(secret, req.body.code, Date.now(), { window: 1 });
		if (step === null) return res.status(400).json(CODE_REFUSED);

		const { codes, stored } = newRecoveryCodes();
		const updated = await AdminModel.updateOne(
			{ _id: admin._id, "mfa.enabled": { $ne: true }, "mfa.pendingSecret": pending },
			{
				$set: {
					"mfa.enabled": true,
					"mfa.secret": pending,
					"mfa.pendingSecret": null,
					"mfa.pendingCreatedAt": null,
					"mfa.enabledAt": new Date(),
					"mfa.lastUsedStep": step,
					"mfa.recoveryCodes": stored,
				},
			},
		).exec();
		if (updated.modifiedCount !== 1)
			return res.status(409).json({ message: "Two-step sign-in changed meanwhile. Reload." });
		await recordAudit(
			{ action: "account.mfa.enabled", actor: adminActor(req), target: { type: "admin", id: admin._id } },
			req,
		);
		res.json({ enabled: true, recoveryCodes: codes });
	} catch (error) {
		log.error("Error confirming two-step enrolment", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** POST /admin/mfa/disable { code | recoveryCode }: turns two-step sign-in off. */
export const handleDisableMfa = async (req: Request, res: Response) => {
	try {
		const admin = await reload(req);
		if (!admin) return res.status(401).json({ message: "Not authorized" });
		if (!admin.mfa?.enabled) return res.status(409).json({ message: "Two-step sign-in is not on." });
		const result = await verifySecondFactor(admin, req.body);
		if (!result.ok) return res.status(400).json(CODE_REFUSED);
		await AdminModel.updateOne(
			{ _id: admin._id },
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
		).exec();
		await recordAudit(
			{
				action: "account.mfa.disabled",
				actor: adminActor(req),
				target: { type: "admin", id: admin._id },
				metadata: { method: result.method },
			},
			req,
		);
		res.json({ enabled: false });
	} catch (error) {
		log.error("Error turning off two-step sign-in", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** POST /admin/mfa/recovery-codes { code }: ten new recovery codes; the old ones stop working. */
export const handleRegenerateRecoveryCodes = async (req: Request, res: Response) => {
	try {
		const admin = await reload(req);
		if (!admin) return res.status(401).json({ message: "Not authorized" });
		if (!admin.mfa?.enabled) return res.status(409).json({ message: "Two-step sign-in is not on." });
		const result = await verifySecondFactor(admin, { code: req.body.code });
		if (!result.ok) return res.status(400).json(CODE_REFUSED);
		const { codes, stored } = newRecoveryCodes();
		await AdminModel.updateOne(
			{ _id: admin._id, "mfa.enabled": true },
			{ $set: { "mfa.recoveryCodes": stored } },
		).exec();
		await recordAudit(
			{
				action: "account.mfa.recovery_codes_regenerated",
				actor: adminActor(req),
				target: { type: "admin", id: admin._id },
			},
			req,
		);
		res.json({ recoveryCodes: codes });
	} catch (error) {
		log.error("Error replacing recovery codes", error);
		res.status(500).json({ message: "Internal server error" });
	}
};
