// The public API hostname is a Cloudflare Worker (helphive-api-edge, WAF in front) that forwards to this Cloud Run
// service with X-Origin-Auth set to a shared secret (ORIGIN_AUTH) and X-Client-IP set to the visitor's address.
// Requests that skip Cloudflare (the *.run.app URL) don't carry the secret: ORIGIN_AUTH_MODE=enforce rejects them
// with 403, any other value only logs them (rollout). Without ORIGIN_AUTH (local development) the check is off.
// X-Client-IP is trusted only together with a valid secret. Cloud Run's own probes hit the container directly.
import crypto from "crypto";
import type { IncomingHttpHeaders } from "http";
import type { NextFunction, Request, Response } from "express";
import log from "./logger";

/** Paths Cloud Run's probes (and nothing else) call on the container directly, without the header. */
export const PROBE_PATHS: ReadonlySet<string> = new Set(["/readyz", "/healthz", "/livez"]);

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const secretMatches = (sent: string | undefined, secret: string) => {
	if (!sent) return false;
	const a = crypto.createHash("sha256").update(sent).digest();
	const b = crypto.createHash("sha256").update(secret).digest();
	return crypto.timingSafeEqual(a, b) && sent.length === secret.length;
};

export type OriginCheck =
	{ status: "off" } | { status: "worker"; clientIp?: string } | { status: "direct"; enforce: boolean };

/** Classifies one request by its headers: no secret configured, came through the Worker, or came directly. */
export const checkOrigin = (headers: IncomingHttpHeaders, env: NodeJS.ProcessEnv = process.env): OriginCheck => {
	const secret = env.ORIGIN_AUTH;
	if (!secret) return { status: "off" };
	if (secretMatches(header(headers["x-origin-auth"]), secret)) {
		const clientIp = header(headers["x-client-ip"])?.trim();
		return { status: "worker", ...(clientIp ? { clientIp } : {}) };
	}
	return { status: "direct", enforce: env.ORIGIN_AUTH_MODE === "enforce" };
};

/** First middleware: lets Worker traffic through with the visitor's IP as req.ip; logs or refuses direct calls. */
export const originAuth = (req: Request, res: Response, next: NextFunction) => {
	if (PROBE_PATHS.has(req.path)) return next();
	const check = checkOrigin(req.headers);
	if (check.status === "off") return next();
	if (check.status === "worker") {
		if (check.clientIp) Object.defineProperty(req, "ip", { value: check.clientIp, configurable: true });
		return next();
	}
	if (!check.enforce) {
		log.warn("Origin auth missing (log only)", { method: req.method, path: req.path });
		return next();
	}
	res.status(403).json({ message: "Forbidden" });
};
