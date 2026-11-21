// Pure verdict rules: Play Integrity payloads and reCAPTCHA Enterprise assessments in, accept or a short reason out.
import crypto from "crypto";
import { ANDROID_APP_ID, SIGNING_KEY_SHA256 } from "../appIdentity";
import { ATTEST_ACTION } from "./config";
import { isDevelopment } from "../../config/allowedOrigins";

export type Verdict =
	{ ok: true; summary: Record<string, unknown> } | { ok: false; reason: string; summary: Record<string, unknown> };

const MAX_AGE_MS = 5 * 60_000;
const MAX_FUTURE_MS = 60_000;

/** What the Android app hashes into its integrity request: base64url (no padding) of sha256 over the UTF-8 text. */
export const expectedRequestHash = (deviceId: string) =>
	crypto.createHash("sha256").update(`helphive-client-attest|${deviceId}`, "utf8").digest("base64url");

/** Colon separated hex fingerprint to the base64url (no padding) form Play Integrity reports. */
export const certDigestFromFingerprint = (fingerprint: string) =>
	Buffer.from(fingerprint.replace(/:/g, ""), "hex").toString("base64url");

export const RELEASE_CERT_DIGEST = certDigestFromFingerprint(SIGNING_KEY_SHA256);

const normalizeDigest = (value: unknown) =>
	typeof value === "string" ? value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") : "";

const asRecord = (value: unknown): Record<string, any> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};

const labels = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];

/** Judges the `tokenPayloadExternal` of a decoded Play Integrity token. The first failing rule wins. */
export const evaluateIntegrityPayload = (
	payload: unknown,
	deviceId: string,
	now = Date.now(),
	certDigest = RELEASE_CERT_DIGEST,
): Verdict => {
	const root = asRecord(payload);
	const request = asRecord(root.requestDetails);
	const app = asRecord(root.appIntegrity);
	const device = asRecord(root.deviceIntegrity);
	const timestamp = Number(request.timestampMillis);
	const ageMs = request.timestampMillis != null && Number.isFinite(timestamp) ? now - timestamp : null;
	const certMatch = labels(app.certificateSha256Digest).map(normalizeDigest).includes(certDigest);
	const deviceLabels = labels(device.deviceRecognitionVerdict);
	const summary = {
		appRecognitionVerdict: typeof app.appRecognitionVerdict === "string" ? app.appRecognitionVerdict : null,
		certMatch: certMatch ? "yes" : "no",
		deviceLabels,
		licensingVerdict: asRecord(root.accountDetails).appLicensingVerdict ?? null,
		ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
	};
	const fail = (reason: string): Verdict => ({ ok: false, reason, summary: { ...summary, reason } });

	if (request.requestPackageName !== ANDROID_APP_ID) return fail("package");
	if (request.requestHash !== expectedRequestHash(deviceId)) return fail("request_hash");
	if (ageMs === null || ageMs > MAX_AGE_MS || ageMs < -MAX_FUTURE_MS) return fail("stale");
	// Sideloaded builds are UNRECOGNIZED_VERSION, which is fine; only "not evaluated" and a foreign cert are refused.
	if (
		typeof app.appRecognitionVerdict !== "string" ||
		app.appRecognitionVerdict === "UNEVALUATED" ||
		app.packageName !== ANDROID_APP_ID ||
		!certMatch
	)
		return fail("app_cert");
	if (!deviceLabels.includes("MEETS_DEVICE_INTEGRITY")) return fail("device_integrity");
	return { ok: true, summary };
};

// Production web hosts only; localhost when NODE_ENV is explicitly "development". Preview channels are not accepted.
const WEB_HOSTS = new Set(["helphive.himaiz.com"]);

export const isAllowedWebHostname = (hostname: unknown) => {
	if (typeof hostname !== "string") return false;
	const host = hostname.toLowerCase();
	return WEB_HOSTS.has(host) || (isDevelopment() && host === "localhost");
};

/** Judges a reCAPTCHA Enterprise assessment response for the web client. */
export const evaluateRecaptchaAssessment = (assessment: unknown, minScore: number): Verdict => {
	const root = asRecord(assessment);
	const props = asRecord(root.tokenProperties);
	const score = asRecord(root.riskAnalysis).score;
	const summary: Record<string, unknown> = {
		score: typeof score === "number" ? score : null,
		hostname: typeof props.hostname === "string" ? props.hostname : null,
	};
	const fail = (reason: string, extra: Record<string, unknown> = {}): Verdict => ({
		ok: false,
		reason,
		summary: { ...summary, ...extra, reason },
	});
	if (props.valid !== true) return fail("recaptcha_invalid", { invalidReason: props.invalidReason ?? null });
	if (props.action !== ATTEST_ACTION) return fail("recaptcha_action");
	if (!isAllowedWebHostname(props.hostname)) return fail("recaptcha_hostname");
	if (typeof score !== "number" || score < minScore) return fail("recaptcha_score");
	return { ok: true, summary };
};
