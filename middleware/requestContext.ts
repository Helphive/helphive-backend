import { NextFunction, Request, Response } from "express";
import { GOOGLE_CLOUD_PROJECT_ID } from "../config/config";
import { buildRequestContext, runWithContext } from "../lib/requestContext";
import { buildRequestLogEntry, writeEntry } from "../lib/logger";

const projectId = () => process.env.GOOGLE_CLOUD_PROJECT || GOOGLE_CLOUD_PROJECT_ID;

/** The matched route pattern while still inside the router (Express resets baseUrl once the router is left). */
const routePattern = (req: Request) => {
	const path = req.route?.path;
	return typeof path === "string" ? `${req.baseUrl}${path}` : undefined;
};

/**
 * First middleware: builds the request context (request id, client address, user agent, app headers, trace), returns
 * X-Request-Id, adds `requestId` to JSON error bodies, and writes one `request` line when the response finishes
 * (health probes and CORS preflights at debug, so LOG_LEVEL=info leaves them out).
 */
export const requestContext = (req: Request, res: Response, next: NextFunction) => {
	const started = process.hrtime.bigint();
	const context = buildRequestContext(req.headers, req.ip, projectId());
	req.context = context;
	res.setHeader("X-Request-Id", context.requestId);

	// Error bodies carry the request id so a person reporting a problem can quote it. Additive: existing fields stay.
	const json = res.json.bind(res);
	res.json = (body?: unknown) => {
		context.route ??= routePattern(req);
		if (
			res.statusCode >= 400 &&
			body &&
			typeof body === "object" &&
			!Array.isArray(body) &&
			!("requestId" in body)
		) {
			return json({ ...(body as Record<string, unknown>), requestId: context.requestId });
		}
		return json(body);
	};
	const end = res.end.bind(res) as (...args: unknown[]) => Response;
	res.end = ((...args: unknown[]) => {
		context.route ??= routePattern(req);
		return end(...args);
	}) as Response["end"];

	res.on("finish", () => {
		writeEntry(
			buildRequestLogEntry(
				{
					method: req.method,
					path: req.path,
					status: res.statusCode,
					latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
				},
				context,
			),
		);
	});

	runWithContext(context, next);
};

/**
 * Re-enters the request context. Body parsers and multer resume the middleware chain from stream callbacks, which
 * lose AsyncLocalStorage; mount this after them so handlers (and the events and logs they write) see the context.
 */
export const bindRequestContext = (req: Request, _res: Response, next: NextFunction) => {
	if (req.context) return runWithContext(req.context, next);
	next();
};
