// Client attestation settings, read from the environment on every call so tests and rollouts can change them.
// See scratch/client-attest/CONTRACT.md. Mode "off" is the default: nothing is checked until it is switched on.
import { GOOGLE_CLOUD_PROJECT_ID } from "../../config/config";

export type AttestMode = "off" | "log" | "enforce";

export const PASS_AUDIENCE = "helphive-client";
export const ATTEST_ACTION = "client_attest";
const MIN_SECRET_LENGTH = 32;

export const attestMode = (value = process.env.CLIENT_ATTEST_MODE): AttestMode => {
	const mode = (value ?? "").trim().toLowerCase();
	return mode === "log" || mode === "enforce" ? mode : "off";
};

/** The pass signing secret, or null while it is missing or shorter than 32 characters. */
export const passSecret = (value = process.env.CLIENT_PASS_SECRET) =>
	value && value.length >= MIN_SECRET_LENGTH ? value : null;

const positiveInt = (value: string | undefined, fallback: number) => {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** Pass lifetime in seconds: CLIENT_PASS_TTL_ANDROID_SEC (default 3600), CLIENT_PASS_TTL_WEB_SEC (default 43200). */
export const passTtlSeconds = (platform: "android" | "web", env: NodeJS.ProcessEnv = process.env) =>
	platform === "android"
		? positiveInt(env.CLIENT_PASS_TTL_ANDROID_SEC, 3600)
		: positiveInt(env.CLIENT_PASS_TTL_WEB_SEC, 43200);

export const recaptchaSiteKey = () => process.env.RECAPTCHA_SITE_KEY?.trim() || null;

/** Lowest reCAPTCHA score accepted (RECAPTCHA_MIN_SCORE, default 0.5). */
export const recaptchaMinScore = (value = process.env.RECAPTCHA_MIN_SCORE) => {
	const parsed = Number.parseFloat(value ?? "");
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.5;
};

/** ATTEST_DEBUG_TOKENS: comma separated; entries shorter than 32 characters are ignored. */
export const debugTokens = (value = process.env.ATTEST_DEBUG_TOKENS) =>
	(value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length >= MIN_SECRET_LENGTH);

export const cloudProjectId = () => process.env.GOOGLE_CLOUD_PROJECT || GOOGLE_CLOUD_PROJECT_ID;
