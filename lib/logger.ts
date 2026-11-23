// The one logger, in the shared logging standard (OracleVMOps LOGGING.md): each call writes one JSON object on one
// line to stdout with `time`, `level`, `app`, `part`, `event` (a fixed snake_case name per call site), `ray` (the
// visitor's Cloudflare ray) and `msg`, plus `severity` and the trace fields Cloud Logging reads, so a line groups with
// Cloud Run's own request log. Request id, route, actor ids and app platform/version come from the request context.
//
// Never pass request bodies, cookies, tokens, passwords, emails or phone numbers. Email addresses inside messages are
// masked as a safety net, and error objects are reduced to name, message, code and stack (never sent to a client).
// LOG_LEVEL (debug, info, warn, error; default info) drops lines below it.
import { getRequestContext, type RequestContext } from "./requestContext";
import { maskEmailsIn, redact } from "./redact";

export type Severity = "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL";
export type Level = "debug" | "info" | "warn" | "error";

export const APP = "helphive" as const;
export const PART = "api" as const;

export interface LogEntry {
	time: string;
	level: Level;
	app: typeof APP;
	part: typeof PART;
	event: string;
	ray?: string;
	msg: string;
	/** Cloud Logging's level field. */
	severity: Severity;
	requestId?: string;
	route?: string;
	userId?: string;
	adminId?: string;
	appPlatform?: string;
	appVersion?: string;
	/** Request lines only. */
	method?: string;
	status?: number;
	ms?: number;
	error?: { name?: string; message: string; code?: string | number; type?: string; stack?: string };
	details?: unknown;
	"logging.googleapis.com/trace"?: string;
	"logging.googleapis.com/spanId"?: string;
	"logging.googleapis.com/trace_sampled"?: boolean;
	[key: string]: unknown;
}

const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const levelOf = (severity: Severity): Level =>
	severity === "DEBUG"
		? "debug"
		: severity === "WARNING"
			? "warn"
			: severity === "ERROR" || severity === "CRITICAL"
				? "error"
				: "info";

const minRank = () => RANK[(process.env.LOG_LEVEL ?? "").toLowerCase() as Level] ?? RANK.info;

const isErrorLike = (value: unknown): value is { message: string; name?: string; stack?: string } =>
	value instanceof Error ||
	(!!value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string");

/** Name, message, code and stack of an error-like value; nothing else (axios errors carry headers with keys). */
export const serializeError = (value: unknown): LogEntry["error"] => {
	if (!isErrorLike(value)) return { message: maskEmailsIn(String(value)).slice(0, MAX_MESSAGE) };
	const error = value as Error & { code?: unknown; type?: unknown; statusCode?: unknown };
	const code = typeof error.code === "string" || typeof error.code === "number" ? error.code : undefined;
	return {
		...(error.name ? { name: String(error.name) } : {}),
		message: maskEmailsIn(String(error.message)).slice(0, MAX_MESSAGE),
		...(code !== undefined ? { code } : {}),
		...(typeof error.type === "string" ? { type: error.type } : {}),
		...(typeof error.stack === "string" ? { stack: maskEmailsIn(error.stack).slice(0, MAX_STACK) } : {}),
	};
};

/** The standard's leading fields, in order. */
const head = (severity: Severity, event: string, msg: string, context: RequestContext | undefined, now: Date) => ({
	time: now.toISOString(),
	level: levelOf(severity),
	app: APP,
	part: PART,
	event,
	...(context?.ray ? { ray: context.ray } : {}),
	msg: maskEmailsIn(String(msg)).slice(0, MAX_MESSAGE),
	severity,
});

/** Fields every line about a request carries. */
export const contextFields = (context: RequestContext | undefined): Partial<LogEntry> => {
	if (!context) return {};
	return {
		requestId: context.requestId,
		...(context.route ? { route: context.route } : {}),
		...(context.actor?.type === "admin" ? { adminId: context.actor.id } : {}),
		...(context.actor && context.actor.type !== "admin" && context.actor.type !== "anonymous"
			? { userId: context.actor.id }
			: {}),
		...(context.platform ? { appPlatform: context.platform } : {}),
		...(context.appVersion ? { appVersion: context.appVersion } : {}),
		...(context.trace ? { "logging.googleapis.com/trace": context.trace } : {}),
		...(context.spanId ? { "logging.googleapis.com/spanId": context.spanId } : {}),
		...(context.traceSampled !== undefined ? { "logging.googleapis.com/trace_sampled": context.traceSampled } : {}),
	};
};

/**
 * One log entry. `args` are what console.* calls used to receive after the message: the first error-like value
 * becomes `error`, other values are redacted into `details`.
 */
export const buildLogEntry = (
	severity: Severity,
	event: string,
	msg: string,
	args: unknown[] = [],
	context: RequestContext | undefined = getRequestContext(),
	now: Date = new Date(),
): LogEntry => {
	const entry: LogEntry = { ...head(severity, event, msg, context, now), ...contextFields(context) };
	const details: unknown[] = [];
	for (const arg of args) {
		if (arg === undefined) continue;
		if (!entry.error && isErrorLike(arg)) entry.error = serializeError(arg);
		else details.push(redact(arg, { maxDepth: 4, maxStringLength: 500, maxArrayLength: 20 }));
	}
	if (details.length) entry.details = details.length === 1 ? details[0] : details;
	// Cloud Error Reporting picks up ERROR entries that carry the stack.
	if (entry.error?.stack && (severity === "ERROR" || severity === "CRITICAL")) {
		entry.stack_trace = entry.error.stack;
	}
	return entry;
};

export interface RequestLogInput {
	method: string;
	/** req.path: only used to spot health probes; never logged. */
	path: string;
	status: number;
	latencyMs: number;
}

/** Cloud Run's probes; logged at debug like CORS preflights. */
export const PROBE_PATHS: ReadonlySet<string> = new Set(["/healthz", "/livez", "/readyz"]);

/** Request lines: every 5xx at error, probes and preflights at debug, everything else at info. */
export const requestSeverity = (input: Pick<RequestLogInput, "method" | "path" | "status">): Severity =>
	input.status >= 500 ? "ERROR" : input.method === "OPTIONS" || PROBE_PATHS.has(input.path) ? "DEBUG" : "INFO";

/**
 * Route for a request no route handled: rejected by middleware before routing (client pass, sign-in, rate limit) or
 * answered by the catch-all 404 ("*"). The first path segment only ("/auth/*"), as the edge logs it: the rest of the
 * path can carry ids and tokens.
 */
export const coarseRoute = (path: string) => {
	const first = path.split("/")[1];
	return first ? `/${first.slice(0, 40)}/*` : "/";
};

/**
 * The full request path without query or fragment. req.path is relative to the current mount point, so a response
 * sent from middleware mounted at "/auth" would read "/login"; the original URL keeps the prefix.
 */
export const fullPath = (originalUrl: string) => originalUrl.split(/[?#]/, 1)[0] || "/";

/** The line for one finished request: the matched route pattern (never the raw URL), status and duration. */
export const buildRequestLogEntry = (
	input: RequestLogInput,
	context: RequestContext | undefined,
	now: Date = new Date(),
): LogEntry => {
	const matched = context?.route && context.route !== "*" ? context.route : undefined;
	const route = matched ?? (PROBE_PATHS.has(input.path) ? input.path : coarseRoute(input.path));
	const ms = Math.max(0, Math.round(input.latencyMs));
	return {
		...head(requestSeverity(input), "request", `${input.method} ${route} ${input.status}`, context, now),
		...contextFields(context),
		route,
		method: input.method,
		status: input.status,
		ms,
	};
};

type Sink = (line: string, severity: Severity) => void;

const defaultSink: Sink = (line) => {
	process.stdout.write(`${line}\n`);
};

let sink: Sink = defaultSink;

/** Tests swap the output; returns the previous sink. */
export const setLogSink = (next: Sink): Sink => {
	const previous = sink;
	sink = next;
	return previous;
};

/** Writes the entry unless its level is below LOG_LEVEL. */
export const writeEntry = (entry: LogEntry) => {
	if (RANK[entry.level] < minRank()) return;
	let line: string;
	try {
		line = JSON.stringify(entry);
	} catch {
		line = JSON.stringify({ ...head(entry.severity, entry.event, entry.msg, undefined, new Date(entry.time)) });
	}
	try {
		sink(line, entry.severity);
	} catch {
		// Logging must never break a request.
	}
};

// The error tracker (lib/observability/runtime.ts) is told about each ERROR and CRITICAL line, after it is written.
let errorObserver: ((entry: LogEntry) => void) | null = null;
export const observeErrorLogs = (observer: ((entry: LogEntry) => void) | null) => {
	errorObserver = observer;
};

const at =
	(severity: Severity) =>
	(event: string, msg: string, ...args: unknown[]) => {
		const entry = buildLogEntry(severity, event, msg, args);
		writeEntry(entry);
		if (errorObserver && (severity === "ERROR" || severity === "CRITICAL")) {
			try {
				errorObserver(entry);
			} catch {
				// Observing must never break logging.
			}
		}
	};

export const log = {
	debug: at("DEBUG"),
	info: at("INFO"),
	notice: at("NOTICE"),
	warn: at("WARNING"),
	error: at("ERROR"),
	critical: at("CRITICAL"),
};

export default log;
