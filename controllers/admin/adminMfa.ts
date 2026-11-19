// Checking an admin's second factor (TOTP code or recovery code), consuming it atomically so it works once.
import AdminModel, { type Admin } from "../../dal/models/admin.model";
import { mfaMasterKey, open, subKey } from "../../lib/secretBox";
import { base32Decode, matchRecoveryCode, verifyTotp } from "../../lib/totp";

export const mfaKeys = () => {
	const { key } = mfaMasterKey();
	return { secretKey: subKey(key, "totp-secret"), recoveryKey: subKey(key, "recovery-codes") };
};

export type SecondFactorResult =
	| { ok: true; method: "totp" | "recovery"; remainingRecoveryCodes: number }
	| { ok: false };

/** The TOTP secret of an enrolled admin, or of a pending enrolment. */
export const totpSecretOf = (sealed: string | null | undefined) =>
	sealed ? base32Decode(open(sealed, mfaKeys().secretKey)) : null;

/**
 * Verifies and consumes a code. A TOTP code is accepted once (its time step is stored and anything at or before it
 * is refused); a recovery code is marked used. Both updates are conditional, so two requests with the same code
 * cannot both pass.
 */
export const verifySecondFactor = async (
	admin: Admin,
	input: { code?: unknown; recoveryCode?: unknown },
	now = Date.now(),
): Promise<SecondFactorResult> => {
	if (!admin.mfa?.enabled || !admin.mfa.secret) return { ok: false };
	const remaining = () => (admin.mfa?.recoveryCodes ?? []).filter((c) => !c.usedAt).length;

	if (typeof input.code === "string" && input.code) {
		const lastUsedStep = admin.mfa.lastUsedStep ?? -1;
		const step = verifyTotp(totpSecretOf(admin.mfa.secret) as Buffer, input.code, now, { window: 1, lastUsedStep });
		if (step === null) return { ok: false };
		const claimed = await AdminModel.updateOne(
			{
				_id: admin._id,
				"mfa.enabled": true,
				$or: [{ "mfa.lastUsedStep": null }, { "mfa.lastUsedStep": { $lt: step } }],
			},
			{ $set: { "mfa.lastUsedStep": step } },
		).exec();
		return claimed.modifiedCount === 1
			? { ok: true, method: "totp", remainingRecoveryCodes: remaining() }
			: { ok: false };
	}

	if (typeof input.recoveryCode === "string" && input.recoveryCode) {
		const index = matchRecoveryCode(admin.mfa.recoveryCodes ?? [], input.recoveryCode, mfaKeys().recoveryKey);
		if (index === -1) return { ok: false };
		const claimed = await AdminModel.updateOne(
			{ _id: admin._id, "mfa.enabled": true, [`mfa.recoveryCodes.${index}.usedAt`]: null },
			{ $set: { [`mfa.recoveryCodes.${index}.usedAt`]: new Date(now) } },
		).exec();
		return claimed.modifiedCount === 1
			? { ok: true, method: "recovery", remainingRecoveryCodes: remaining() - 1 }
			: { ok: false };
	}
	return { ok: false };
};
