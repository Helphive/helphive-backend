// Checks the X-Client-Pass header (see routes/clientAttest.route.ts) on /auth, /email and /public.
// Modes (CLIENT_ATTEST_MODE): off = no checks; log = check and log, never block; enforce = 428 CLIENT_PASS_REQUIRED.
// Mounted in index.ts for those prefixes only, so /admin, /webhook, /client-errors and probes are never checked.
import { NextFunction, Request, Response } from "express";
import log from "../lib/logger";
import { attestMode, passSecret } from "../lib/clientAttest/config";
import { PassOutcome, Platform, verifyPass } from "../lib/clientAttest/pass";

declare module "express" {
	interface Locals {
		/** Set by clientPassGuard on checked requests. */
		clientPass?: { outcome: PassOutcome; platform?: Platform };
	}
}

/** Links opened from emails in a plain browser: GET /auth/verify-email and everything under /auth/reset-password. */
const isExempt = (req: Request) => {
	if (req.method === "OPTIONS") return true;
	const path = `${req.baseUrl}${req.path}`.toLowerCase().replace(/\/+$/, "");
	if (path === "/auth/verify-email") return req.method === "GET" || req.method === "HEAD";
	return path === "/auth/reset-password" || path.startsWith("/auth/reset-password/");
};

let missingSecretLogged = false;

export const clientPassGuard = (req: Request, res: Response, next: NextFunction) => {
	const mode = attestMode();
	if (mode === "off" || isExempt(req)) return next();

	const secret = passSecret();
	if (!secret && !missingSecretLogged) {
		missingSecretLogged = true;
		log.error("Client attestation: CLIENT_PASS_SECRET is missing or shorter than 32 characters; not enforcing");
	}
	// Without a usable secret nothing can be verified, so even enforce mode only observes.
	const enforcing = mode === "enforce" && !!secret;
	const header = req.get("x-client-pass")?.trim();
	const deviceId = req.get("x-device-id")?.trim();
	const result = secret
		? verifyPass(header, secret, deviceId)
		: { outcome: header ? "invalid" : ("missing" as PassOutcome) };
	res.locals.clientPass = result;
	if (result.outcome === "valid") return next();

	log.warn("Client pass not valid", {
		outcome: result.outcome,
		appPlatform: req.get("x-app-platform"),
		method: req.method,
		path: `${req.baseUrl}${req.path}`,
		enforced: enforcing,
	});
	if (enforcing) return res.status(428).json({ code: "CLIENT_PASS_REQUIRED" });
	next();
};
