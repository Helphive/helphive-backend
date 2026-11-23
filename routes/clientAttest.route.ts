// POST /client-attest: trades proof that the caller is a genuine HelpHive client (Play Integrity token from our signed
// Android app, reCAPTCHA Enterprise token from our website, or a configured debug token) for a short-lived client pass,
// which clients then send as X-Client-Pass (middleware/clientPass.ts). Mounted in index.ts after the JSON parser.
// Never log tokens. Contract: scratch/client-attest/CONTRACT.md.
import express, { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import log from "../lib/logger";
import {
	attestMode,
	debugTokens,
	passSecret,
	passTtlSeconds,
	recaptchaMinScore,
	recaptchaSiteKey,
} from "../lib/clientAttest/config";
import { AttestGoogle, GoogleCallError, googleAttest } from "../lib/clientAttest/google";
import { Platform, isDebugToken, signPass } from "../lib/clientAttest/pass";
import { evaluateIntegrityPayload, evaluateRecaptchaAssessment, type Verdict } from "../lib/clientAttest/verdict";
import { markRouteBase } from "../middleware/requestContext";

const DEVICE_ID = /^[A-Za-z0-9._-]{8,128}$/;
const MAX_TOKEN_LENGTH = 32_768;

const badRequest = (res: Response) => res.status(400).json({ code: "BAD_REQUEST" });
const unavailable = (res: Response) => res.status(503).json({ code: "CLIENT_ATTESTATION_UNAVAILABLE" });
const refuse = (res: Response, reason: string) => res.status(403).json({ code: "CLIENT_ATTESTATION_FAILED", reason });

const tokenField = (value: unknown) =>
	typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH ? value : null;

/** Google answered 400: the token itself was refused. Anything else (network, 5xx, permissions) is on our side. */
const tokenRefused = (error: unknown) => error instanceof GoogleCallError && error.status === 400;

export const createClientAttestHandler =
	(google: AttestGoogle = googleAttest, now: () => number = Date.now): RequestHandler =>
	async (req: Request, res: Response) => {
		const secret = passSecret();
		if (attestMode() === "off" || !secret) return unavailable(res);

		const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
		const platform = body.platform as Platform;
		const deviceId = body.deviceId;
		const proofs = (["integrityToken", "recaptchaToken", "debugToken"] as const).filter(
			(name) => body[name] !== undefined,
		);
		const headerDeviceId = req.get("x-device-id")?.trim();
		if (
			(platform !== "android" && platform !== "web") ||
			typeof deviceId !== "string" ||
			!DEVICE_ID.test(deviceId) ||
			proofs.length !== 1 ||
			!tokenField(body[proofs[0]]) ||
			(proofs[0] === "integrityToken" && platform !== "android") ||
			(proofs[0] === "recaptchaToken" && platform !== "web") ||
			headerDeviceId !== deviceId
		)
			return badRequest(res);

		let verdict: Verdict;
		let debug = false;
		try {
			if (proofs[0] === "debugToken") {
				debug = true;
				const accepted = isDebugToken(body.debugToken, debugTokens());
				verdict = accepted
					? { ok: true, summary: {} }
					: { ok: false, reason: "debug_token", summary: { reason: "debug_token" } };
			} else if (proofs[0] === "integrityToken") {
				try {
					const decoded = (await google.decodeIntegrityToken(body.integrityToken)) as {
						tokenPayloadExternal?: unknown;
					};
					verdict = evaluateIntegrityPayload(decoded?.tokenPayloadExternal, deviceId, now());
				} catch (error) {
					if (!tokenRefused(error)) throw error;
					verdict = { ok: false, reason: "decode_failed", summary: { reason: "decode_failed" } };
				}
			} else {
				const siteKey = recaptchaSiteKey();
				if (!siteKey) {
					log.error("recaptcha_site_key_missing", "Client attestation: RECAPTCHA_SITE_KEY is not set");
					return unavailable(res);
				}
				try {
					const assessment = await google.createAssessment({
						token: body.recaptchaToken,
						siteKey,
						userAgent: req.context?.userAgent,
						ip: req.ip,
					});
					verdict = evaluateRecaptchaAssessment(assessment, recaptchaMinScore());
				} catch (error) {
					if (!tokenRefused(error)) throw error;
					verdict = { ok: false, reason: "recaptcha_invalid", summary: { reason: "recaptcha_invalid" } };
				}
			}
		} catch (error) {
			log.error("attestation_google_failed", "Client attestation: Google call failed", error);
			return unavailable(res);
		}

		log[verdict.ok ? "info" : "warn"](
			verdict.ok ? "attestation_accepted" : "attestation_refused",
			`Client attestation ${verdict.ok ? "accepted" : "refused"}`,
			{
				platform,
				method: debug ? "debug" : proofs[0],
				...verdict.summary,
			},
		);
		if (!verdict.ok) return refuse(res, verdict.reason);
		const ttlSeconds = passTtlSeconds(platform);
		return res.json(signPass(secret, { platform, deviceId, debug, ttlSeconds }, now()));
	};

/** Mounted right after express.json in index.ts: a malformed or oversized JSON body is BAD_REQUEST here, not the generic message. */
export const attestBodyError: ErrorRequestHandler = (err, _req, res, next) =>
	err?.type === "entity.parse.failed" || err?.type === "entity.too.large" ? badRequest(res) : next(err);

const clientAttestRoute = express.Router();
clientAttestRoute.use(markRouteBase);
clientAttestRoute.post("/", createClientAttestHandler());

export default clientAttestRoute;
