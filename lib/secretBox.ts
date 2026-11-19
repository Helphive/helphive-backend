// AES-256-GCM encryption for small secrets at rest (admin TOTP secrets), and the derived keys for recovery-code
// hashes. Key: ADMIN_MFA_ENCRYPTION_KEY, 32 bytes as 64 hex characters or base64 (generate one with
// `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
//
// Fallback when it is unset: a key derived (HKDF-SHA256) from ADMIN_ACCESS_TOKEN_SECRET, else ACCESS_TOKEN_SECRET.
// That works, but rotating that token secret would then make every stored TOTP secret unreadable, and every admin
// with two-step sign-in would need a super admin to reset it. Set the dedicated key before anyone enrols.
// Each ciphertext names the key it was made with (a short fingerprint), so a key mismatch is reported clearly.
import crypto from "crypto";

const VERSION = "v1";

export class SecretBoxKeyError extends Error {}

/** 32 key bytes from the configured value: hex, base64, or any other string stretched with HKDF. */
export const keyFromConfig = (value: string, label: string): Buffer => {
	const trimmed = value.trim();
	if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
	if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(trimmed)) {
		const decoded = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
		if (decoded.length === 32) return decoded;
	}
	return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(trimmed), Buffer.alloc(0), Buffer.from(label), 32));
};

export interface MfaKeySource {
	ADMIN_MFA_ENCRYPTION_KEY?: string;
	ADMIN_ACCESS_TOKEN_SECRET?: string;
	ACCESS_TOKEN_SECRET?: string;
}

/** The master key for admin MFA data and whether it is the dedicated one or the documented fallback. */
export const mfaMasterKey = (env: MfaKeySource = process.env as MfaKeySource) => {
	if (env.ADMIN_MFA_ENCRYPTION_KEY?.trim()) {
		return { key: keyFromConfig(env.ADMIN_MFA_ENCRYPTION_KEY, "helphive-admin-mfa"), dedicated: true };
	}
	const fallback = env.ADMIN_ACCESS_TOKEN_SECRET || env.ACCESS_TOKEN_SECRET || "";
	if (!fallback) throw new SecretBoxKeyError("No key is configured for admin two-step sign-in.");
	return { key: keyFromConfig(`mfa-fallback:${fallback}`, "helphive-admin-mfa"), dedicated: false };
};

/** Separate sub-keys for separate uses, so one key never serves two purposes. */
export const subKey = (master: Buffer, purpose: string) =>
	Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(`helphive:${purpose}`), 32));

export const keyFingerprint = (key: Buffer) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);

export const seal = (plaintext: string, key: Buffer): string => {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [
		VERSION,
		keyFingerprint(key),
		iv.toString("base64url"),
		tag.toString("base64url"),
		body.toString("base64url"),
	].join(":");
};

export const open = (sealed: string, key: Buffer): string => {
	const parts = sealed.split(":");
	if (parts.length !== 5 || parts[0] !== VERSION) throw new SecretBoxKeyError("Unrecognised ciphertext.");
	if (parts[1] !== keyFingerprint(key)) {
		throw new SecretBoxKeyError(
			"This secret was encrypted with a different key (was ADMIN_MFA_ENCRYPTION_KEY changed?).",
		);
	}
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64url"));
	decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
	return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64url")), decipher.final()]).toString("utf8");
};
