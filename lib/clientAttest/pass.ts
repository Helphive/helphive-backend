// The client pass: a short-lived HS256 JWT proving this device passed attestation, and the debug-token check.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { PASS_AUDIENCE } from "./config";

export type Platform = "android" | "web";
export type PassOutcome = "valid" | "missing" | "invalid" | "expired" | "device_mismatch";

export const signPass = (
	secret: string,
	input: { platform: Platform; deviceId: string; debug?: boolean; ttlSeconds: number },
	nowMs = Date.now(),
) => {
	const iat = Math.floor(nowMs / 1000);
	const exp = iat + input.ttlSeconds;
	const pass = jwt.sign(
		{
			typ: "client-pass",
			plt: input.platform,
			did: input.deviceId,
			...(input.debug ? { dbg: true } : {}),
			aud: PASS_AUDIENCE,
			iat,
			exp,
		},
		secret,
		{ algorithm: "HS256" },
	);
	return { pass, expiresAt: exp * 1000 };
};

/** Checks signature (HS256 only), typ, aud, exp and that the pass belongs to `deviceId`. */
export const verifyPass = (
	token: string | undefined,
	secret: string,
	deviceId: string | undefined,
): { outcome: PassOutcome; platform?: Platform } => {
	if (!token) return { outcome: "missing" };
	try {
		const claims = jwt.verify(token, secret, { algorithms: ["HS256"], audience: PASS_AUDIENCE }) as jwt.JwtPayload;
		if (claims.typ !== "client-pass" || (claims.plt !== "android" && claims.plt !== "web"))
			return { outcome: "invalid" };
		if (!deviceId || claims.did !== deviceId) return { outcome: "device_mismatch", platform: claims.plt };
		return { outcome: "valid", platform: claims.plt };
	} catch (error) {
		return { outcome: error instanceof jwt.TokenExpiredError ? "expired" : "invalid" };
	}
};

const digest = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest();

/** True when `candidate` equals a configured debug token. Compared timing-safe on digests; every entry is checked. */
export const isDebugToken = (candidate: string, configured: string[]) => {
	const probe = digest(candidate);
	let match = false;
	for (const token of configured) if (crypto.timingSafeEqual(probe, digest(token))) match = true;
	return match;
};
