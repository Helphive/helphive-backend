// Run with: npx ts-node tests/totp.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
	base32Decode,
	base32Encode,
	generateRecoveryCodes,
	generateTotpSecret,
	hashRecoveryCode,
	hotp,
	matchRecoveryCode,
	normalizeRecoveryCode,
	otpauthUri,
	totp,
	verifyTotp,
	RECOVERY_CODE_COUNT,
} from "../lib/totp";
import { keyFingerprint, keyFromConfig, mfaMasterKey, open, seal, SecretBoxKeyError, subKey } from "../lib/secretBox";

// RFC 6238 appendix B: seeds are the ASCII digits repeated to 20, 32 and 64 bytes.
const SEEDS = {
	sha1: Buffer.from("12345678901234567890"),
	sha256: Buffer.from("12345678901234567890123456789012"),
	sha512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
} as const;

const RFC6238 = [
	{ time: 59, sha1: "94287082", sha256: "46119246", sha512: "90693936" },
	{ time: 1111111109, sha1: "07081804", sha256: "68084774", sha512: "25091201" },
	{ time: 1111111111, sha1: "14050471", sha256: "67062674", sha512: "99943326" },
	{ time: 1234567890, sha1: "89005924", sha256: "91819424", sha512: "93441116" },
	{ time: 2000000000, sha1: "69279037", sha256: "90698825", sha512: "38618901" },
	{ time: 20000000000, sha1: "65353130", sha256: "77737706", sha512: "47863826" },
];

test("TOTP matches every RFC 6238 test vector (SHA-1, SHA-256, SHA-512, 8 digits)", () => {
	for (const vector of RFC6238) {
		for (const algorithm of ["sha1", "sha256", "sha512"] as const) {
			assert.equal(
				totp(SEEDS[algorithm], vector.time * 1000, { digits: 8, algorithm }),
				vector[algorithm],
				`${algorithm} at ${vector.time}`,
			);
		}
	}
});

test("HOTP matches the RFC 4226 appendix D values", () => {
	const expected = [
		"755224",
		"287082",
		"359152",
		"969429",
		"338314",
		"254676",
		"287922",
		"162583",
		"399871",
		"520489",
	];
	expected.forEach((value, counter) => assert.equal(hotp(SEEDS.sha1, counter), value));
});

test("base32 round-trips and decodes the RFC seed's usual encoding", () => {
	assert.equal(base32Encode(SEEDS.sha1), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
	assert.deepEqual(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq"), SEEDS.sha1);
	for (let i = 0; i < 20; i++) {
		const bytes = crypto.randomBytes(i);
		assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
	}
	assert.throws(() => base32Decode("not base32!"));
	assert.match(generateTotpSecret(), /^[A-Z2-7]{32}$/);
});

test("verifyTotp accepts the current and adjacent steps, refuses others, and never accepts a step twice", () => {
	const now = 1_700_000_000_000;
	const code = totp(SEEDS.sha1, now);
	const step = Math.floor(now / 30000);
	assert.equal(verifyTotp(SEEDS.sha1, code, now), step);
	assert.equal(verifyTotp(SEEDS.sha1, ` ${code.slice(0, 3)} ${code.slice(3)} `, now), step, "spaces are ignored");
	assert.equal(verifyTotp(SEEDS.sha1, totp(SEEDS.sha1, now - 30000), now), step - 1, "previous step (clock drift)");
	assert.equal(verifyTotp(SEEDS.sha1, totp(SEEDS.sha1, now + 30000), now), step + 1, "next step");
	assert.equal(verifyTotp(SEEDS.sha1, totp(SEEDS.sha1, now - 90000), now), null, "too old");
	// Replay: once a step is used, that code and any earlier one is refused.
	assert.equal(verifyTotp(SEEDS.sha1, code, now, { lastUsedStep: step }), null);
	assert.equal(verifyTotp(SEEDS.sha1, totp(SEEDS.sha1, now - 30000), now, { lastUsedStep: step }), null);
	assert.equal(verifyTotp(SEEDS.sha1, totp(SEEDS.sha1, now + 30000), now, { lastUsedStep: step }), step + 1);
	for (const bad of [undefined, 123456, "12345", "1234567", "abcdef", { $ne: 1 }, ""]) {
		assert.equal(verifyTotp(SEEDS.sha1, bad, now), null, `refuses ${JSON.stringify(bad)}`);
	}
});

test("otpauth URI carries the secret, issuer and parameters authenticator apps expect", () => {
	const uri = otpauthUri("JBSWY3DPEHPK3PXP", "ops@helphive.example");
	assert.match(uri, /^otpauth:\/\/totp\/HelpHive%20Admin:ops%40helphive\.example\?/);
	const params = new URL(uri.replace("otpauth://", "https://x/")).searchParams;
	assert.equal(params.get("secret"), "JBSWY3DPEHPK3PXP");
	assert.equal(params.get("issuer"), "HelpHive Admin");
	assert.equal(params.get("digits"), "6");
	assert.equal(params.get("period"), "30");
	assert.equal(params.get("algorithm"), "SHA1");
});

test("recovery codes: ten distinct codes, hashed with a key, single use, formatting ignored", () => {
	const key = crypto.randomBytes(32);
	const codes = generateRecoveryCodes();
	assert.equal(codes.length, RECOVERY_CODE_COUNT);
	assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT);
	for (const code of codes) assert.match(code, /^[a-z2-9]{5}-[a-z2-9]{5}$/);

	const stored = codes.map((code) => ({ hash: hashRecoveryCode(code, key), usedAt: null as Date | null }));
	assert.ok(
		stored.every((entry) => !codes.some((code) => entry.hash.includes(code))),
		"no code in clear",
	);
	assert.notEqual(hashRecoveryCode(codes[0], key), hashRecoveryCode(codes[0], crypto.randomBytes(32)), "keyed");

	assert.equal(matchRecoveryCode(stored, codes[3], key), 3);
	assert.equal(matchRecoveryCode(stored, codes[3].toUpperCase().replace("-", " "), key), 3);
	assert.equal(normalizeRecoveryCode(" AbCdE-fGhJk "), "abcdefghjk");
	stored[3].usedAt = new Date();
	assert.equal(matchRecoveryCode(stored, codes[3], key), -1, "a used code is refused");
	assert.equal(matchRecoveryCode(stored, "aaaaa-aaaaa", key), -1);
	assert.equal(matchRecoveryCode(stored, { $ne: null }, key), -1);
	assert.equal(matchRecoveryCode(stored, "x".repeat(1000), key), -1);
});

test("secret box: AES-GCM round trip, tamper detection, and a clear error for the wrong key", () => {
	const key = keyFromConfig(crypto.randomBytes(32).toString("base64"), "t");
	const sealed = seal("JBSWY3DPEHPK3PXP", key);
	assert.match(sealed, /^v1:[0-9a-f]{8}:/);
	assert.equal(open(sealed, key), "JBSWY3DPEHPK3PXP");
	assert.notEqual(seal("same", key), seal("same", key), "fresh IV each time");
	const parts = sealed.split(":");
	parts[4] = Buffer.from("tampered").toString("base64url");
	assert.throws(() => open(parts.join(":"), key));
	assert.throws(() => open(sealed, crypto.randomBytes(32)), SecretBoxKeyError);
	assert.equal(keyFingerprint(key).length, 8);
});

test("MFA key: the dedicated variable wins; otherwise a key derived from the token secret (documented fallback)", () => {
	const hex = "ab".repeat(32);
	const dedicated = mfaMasterKey({ ADMIN_MFA_ENCRYPTION_KEY: hex, ADMIN_ACCESS_TOKEN_SECRET: "x" });
	assert.equal(dedicated.dedicated, true);
	assert.deepEqual(dedicated.key, Buffer.from(hex, "hex"));
	const fallback = mfaMasterKey({ ADMIN_ACCESS_TOKEN_SECRET: "admin-secret" });
	assert.equal(fallback.dedicated, false);
	assert.notDeepEqual(fallback.key, Buffer.from("admin-secret"));
	assert.deepEqual(mfaMasterKey({ ACCESS_TOKEN_SECRET: "user" }).key.length, 32);
	assert.throws(() => mfaMasterKey({}), SecretBoxKeyError);
	assert.notDeepEqual(subKey(dedicated.key, "a"), subKey(dedicated.key, "b"));
});
