// Per-request context: request id, client address and the optional client headers, plus who is signed in.
// Stored on the request (req.context) and in AsyncLocalStorage, so handlers, events and logs can all read it without
// passing it around. Pure helpers here; the Express middleware is in middleware/requestContext.ts.
import { AsyncLocalStorage } from "async_hooks";
import crypto from "crypto";

export type ActorType = "user" | "provider" | "admin" | "system" | "anonymous";

export interface RequestContext {
	requestId: string;
	ip?: string;
	userAgent?: string;
	/** X-App-Platform: "ios", "android", "web", "admin" or another short lowercase name. */
	platform?: string;
	/** X-App-Version, e.g. "1.4.2" or "1.4.2+57". */
	appVersion?: string;
	/** X-Device-Id: an opaque per-install id chosen by the client. */
	deviceId?: string;
	/** Cloudflare's ray for the visitor's request (X-CF-Ray from the edge Worker, else CF-Ray), logged as `ray`. */
	ray?: string;
	/** "projects/<project>/traces/<trace id>" from X-Cloud-Trace-Context, for Cloud Logging correlation. */
	trace?: string;
	spanId?: string;
	traceSampled?: boolean;
	/** Express route pattern once routing matched, e.g. "/admin/admins/:id/role". */
	route?: string;
	/** Who is signed in, set by verifyJWT / verifyAdminJWT. */
	actor?: { type: ActorType; id: string };
}

declare module "express" {
	interface Request {
		/** Set by middleware/requestContext.ts on every request. */
		context?: RequestContext;
	}
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The current request's context, or undefined outside a request (start-up, timers started elsewhere). */
export const getRequestContext = (): RequestContext | undefined => storage.getStore();

/** Runs `fn` with `context` as the current request context. */
export const runWithContext = <T>(context: RequestContext, fn: () => T): T => storage.run(context, fn);

const MAX_USER_AGENT = 512;
const PLATFORM = /^[a-z][a-z0-9_-]{0,19}$/;
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
const DEVICE_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/;
const REQUEST_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{7,63}$/;
const TRACE = /^([0-9a-f]{32})(?:\/(\d{1,20}))?(?:;o=([01]))?$/i;
// A Cloudflare ray: 16 hex digits, optionally followed by the data centre ("8a1b2c3d4e5f6a7b-LHR").
const RAY = /^[0-9a-f]{16}(?:-[A-Z]{3})?$/i;

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim();

const matching = (value: string | undefined, pattern: RegExp) => (value && pattern.test(value) ? value : undefined);

/**
 * The optional client headers, validated. A value that is too long or has unexpected characters is dropped rather
 * than rejected: the headers are informational and an old or odd client must keep working.
 */
export const parseClientHeaders = (headers: Record<string, string | string[] | undefined>) => ({
	platform: matching(header(headers["x-app-platform"])?.toLowerCase(), PLATFORM),
	appVersion: matching(header(headers["x-app-version"]), APP_VERSION),
	deviceId: matching(header(headers["x-device-id"]), DEVICE_ID),
});

/** A client-supplied X-Request-Id when it is well formed, else a fresh UUID. */
export const resolveRequestId = (incoming: string | string[] | undefined) =>
	matching(header(incoming), REQUEST_ID) ?? crypto.randomUUID();

/** Trace fields Cloud Logging uses to group a log line with Cloud Run's own request log. */
export const parseTraceHeader = (value: string | string[] | undefined, projectId: string) => {
	const match = TRACE.exec(header(value) ?? "");
	if (!match || !projectId) return {};
	return {
		trace: `projects/${projectId}/traces/${match[1].toLowerCase()}`,
		...(match[2] ? { spanId: match[2] } : {}),
		...(match[3] ? { traceSampled: match[3] === "1" } : {}),
	};
};

/**
 * The visitor's Cloudflare ray. The edge Worker sends it as X-CF-Ray, because Cloudflare gives the Worker's own call
 * to this origin a new CF-Ray; CF-Ray is the fallback for anything that reaches the API another way.
 */
export const parseRay = (headers: Record<string, string | string[] | undefined>) =>
	matching(header(headers["x-cf-ray"]), RAY) ?? matching(header(headers["cf-ray"]), RAY);

/** Builds the context for one request from its headers and resolved client address. */
export const buildRequestContext = (
	headers: Record<string, string | string[] | undefined>,
	ip: string | undefined,
	projectId: string,
): RequestContext => {
	const userAgent = header(headers["user-agent"]);
	const ray = parseRay(headers);
	return {
		requestId: resolveRequestId(headers["x-request-id"]),
		...(ray ? { ray } : {}),
		ip: ip || undefined,
		userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT) : undefined,
		...parseClientHeaders(headers),
		...parseTraceHeader(headers["x-cloud-trace-context"], projectId),
	};
};

/** Marks who is signed in on the current request (no-op outside a request). */
export const setActor = (type: ActorType, id: string, context: RequestContext | undefined = getRequestContext()) => {
	if (context) context.actor = { type, id };
};
