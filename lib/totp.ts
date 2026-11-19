// TOTP (RFC 6238) and HOTP (RFC 4226) with Node's crypto only, plus single-use recovery codes.
// Authenticator apps use SHA-1, 6 digits and 30-second steps; those are the defaults.
import crypto from "crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const base32Encode = (buffer: Buffer): string => {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of buffer) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
};

export const base32Decode = (input: string): Buffer => {
	const clean = input.replace(/[\s=-]/g, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];
	for (const char of clean) {
		const index = BASE32.indexOf(char);
		if (index === -1) throw new Error("Invalid base32 character.");
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(bytes);
};

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

export interface TotpOptions {
	digits?: number;
	period?: number;
	algorithm?: TotpAlgorithm;
}

/** RFC 4226 HOTP value for a counter. */
export const hotp = (key: Buffer, counter: number | bigint, digits = 6, algorithm: TotpAlgorithm = "sha1") => {
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = crypto.createHmac(algorithm, key).update(message).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const binary =
		((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
	return String(binary % 10 ** digits).padStart(digits, "0");
};

export const timeStep = (unixMs: number, period = 30) => Math.floor(unixMs / 1000 / period);

/** RFC 6238 TOTP value at a time. */
export const totp = (key: Buffer, unixMs: number, options: TotpOptions = {}) =>
	hotp(key, timeStep(unixMs, options.period ?? 30), options.digits ?? 6, options.algorithm ?? "sha1");

/**
 * The time step a presented code matches within ±`window` steps of now, or null. Callers store the matched step and
 * refuse any code at or before it next time, so a code cannot be replayed (RFC 6238 section 5.2).
 */
export const verifyTotp = (
	key: Buffer,
	code: unknown,
	unixMs: number,
	{ window = 1, lastUsedStep = -1, ...options }: TotpOptions & { window?: number; lastUsedStep?: number } = {},
): number | null => {
	const digits = options.digits ?? 6;
	if (typeof code !== "string") return null;
	const clean = code.replace(/\s/g, "");
	if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return null;
	const current = timeStep(unixMs, options.period ?? 30);
	let matched: number | null = null;
	// Check every candidate (no early exit) so timing does not reveal which step matched.
	for (let step = current - window; step <= current + window; step++) {
		if (step < 0) continue;
		const expected = Buffer.from(hotp(key, step, digits, options.algorithm ?? "sha1"));
		const presented = Buffer.from(clean);
		if (crypto.timingSafeEqual(expected, presented) && step > lastUsedStep && matched === null) matched = step;
	}
	return matched;
};

/** A new random secret: 20 bytes (160 bits), as RFC 4226 recommends for SHA-1. */
export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

/** otpauth:// URI that authenticator apps read from a QR code. */
export const otpauthUri = (secret: string, accountName: string, issuer = "HelpHive Admin") => {
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
	const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
	return `otpauth://totp/${label}?${params.toString()}`;
};

// Recovery codes: ten single-use codes like "k7m2q-x9p4t" (50 bits each), shown once, stored as keyed hashes.
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

export const generateRecoveryCodes = (count = RECOVERY_CODE_COUNT): string[] => {
	const codes = new Set<string>();
	while (codes.size < count) {
		let raw = "";
		for (let i = 0; i < 10; i++) raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
		codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
	}
	return [...codes];
};

/** Lower-case, no spaces or dashes: what people type is compared, not how it is formatted. */
export const normalizeRecoveryCode = (code: unknown) =>
	typeof code === "string" && code.length <= 64 ? code.toLowerCase().replace(/[\s-]/g, "") : "";

/**
 * HMAC-SHA256 with a server key, so a copy of the database alone is not enough to guess codes offline
 * (50 bits would otherwise be within reach of a GPU against a plain hash).
 */
export const hashRecoveryCode = (code: string, key: Buffer) =>
	crypto
		.createHmac("sha256", key)
		.update(`recovery:${normalizeRecoveryCode(code)}`)
		.digest("hex");

export interface StoredRecoveryCode {
	hash: string;
	usedAt?: Date | null;
}

/** Index of the unused stored code the presented one matches, or -1. Compares every entry in constant time. */
export const matchRecoveryCode = (stored: readonly StoredRecoveryCode[], presented: unknown, key: Buffer) => {
	const normalized = normalizeRecoveryCode(presented);
	if (normalized.length !== 10) return -1;
	const hash = Buffer.from(hashRecoveryCode(normalized, key), "hex");
	let found = -1;
	stored.forEach((entry, index) => {
		const candidate = Buffer.from(entry.hash, "hex");
		if (
			candidate.length === hash.length &&
			crypto.timingSafeEqual(candidate, hash) &&
			!entry.usedAt &&
			found === -1
		)
			found = index;
	});
	return found;
};
