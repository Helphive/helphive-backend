// The one logger. Each call writes a single JSON object on one line to stdout (stderr for errors), in the shape Cloud
// Logging reads from Cloud Run: `severity`, `message`, optional `httpRequest`, and the trace field that groups the
// line with Cloud Run's own request log. Request id, route, actor and app platform/version come from the request
// context automatically.
//
// Never pass request bodies, tokens or passwords. Email addresses inside messages are masked as a safety net, and
// error objects are reduced to name, message, code and stack (the stack stays in the log, never in a response).
import { getRequestContext, type RequestContext } from "./requestContext";
import { maskEmailsIn, redact } from "./redact";

export type Severity = "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL";

export interface HttpRequestLog {
	requestMethod: string;
	requestUrl: string;
	status: number;
	/** Seconds with "s" suffix, e.g. "0.042s", as Cloud Logging expects. */
	latency: string;
	remoteIp?: string;
	userAgent?: string;
	responseSize?: string;
	protocol?: string;
}

export interface LogEntry {
	severity: Severity;
	message: string;
	time: string;
	requestId?: string;
	route?: string;
	userId?: string;
	adminId?: string;
	appPlatform?: string;
	appVersion?: string;
	httpRequest?: HttpRequestLog;
	error?: { name?: string; message: string; code?: string | number; type?: string; stack?: string };
	details?: unknown;
	"logging.googleapis.com/trace"?: string;
	"logging.googleapis.com/spanId"?: string;
	"logging.googleapis.com/trace_sampled"?: boolean;
	[key: string]: unknown;
}

const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;

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
	message: string,
	args: unknown[] = [],
	context: RequestContext | undefined = getRequestContext(),
	now: Date = new Date(),
): LogEntry => {
	const entry: LogEntry = {
		severity,
		message: maskEmailsIn(String(message)).slice(0, MAX_MESSAGE),
		time: now.toISOString(),
		...contextFields(context),
	};
	const details: unknown[] = [];
	for (const arg of args) {
		if (arg === undefined) continue;
		if (!entry.error && isErrorLike(arg)) entry.error = serializeError(arg);
		else details.push(redact(arg, { maxDepth: 4, maxStringLength: 500, maxArrayLength: 20 }));
	}
	if (details.length) entry.details = details.length === 1 ? details[0] : details;
	// Cloud Error Reporting picks up ERROR entries whose message contains the stack.
	if (entry.error?.stack && (severity === "ERROR" || severity === "CRITICAL")) {
		entry.stack_trace = entry.error.stack;
	}
	return entry;
};

export interface RequestLogInput {
	method: string;
	originalUrl: string;
	status: number;
	latencyMs: number;
	responseSize?: number;
	protocol?: string;
}

/** Path without the query string: verification and reset links carry their token there. */
export const pathOnly = (url: string) => {
	const index = url.search(/[?#]/);
	return (index === -1 ? url : url.slice(0, index)).slice(0, 512);
};

export const severityForStatus = (status: number): Severity =>
	status >= 500 ? "ERROR" : status >= 400 ? "WARNING" : "INFO";

/** The access-log line for one finished request. */
export const buildRequestLogEntry = (
	input: RequestLogInput,
	context: RequestContext | undefined,
	now: Date = new Date(),
): LogEntry => {
	const path = pathOnly(input.originalUrl);
	const latency = Math.max(0, input.latencyMs);
	return {
		severity: severityForStatus(input.status),
		message: `${input.method} ${context?.route ?? path} ${input.status} ${Math.round(latency)}ms`,
		time: now.toISOString(),
		...contextFields(context),
		httpRequest: {
			requestMethod: input.method,
			requestUrl: path,
			status: input.status,
			latency: `${(latency / 1000).toFixed(3)}s`,
			...(context?.ip ? { remoteIp: context.ip } : {}),
			...(context?.userAgent ? { userAgent: context.userAgent } : {}),
			...(input.responseSize !== undefined ? { responseSize: String(input.responseSize) } : {}),
			...(input.protocol ? { protocol: input.protocol } : {}),
		},
	};
};

type Sink = (line: string, severity: Severity) => void;

const defaultSink: Sink = (line, severity) => {
	if (severity === "ERROR" || severity === "CRITICAL" || severity === "WARNING") process.stderr.write(`${line}\n`);
	else process.stdout.write(`${line}\n`);
};

let sink: Sink = defaultSink;

/** Tests swap the output; returns the previous sink. */
export const setLogSink = (next: Sink): Sink => {
	const previous = sink;
	sink = next;
	return previous;
};

export const writeEntry = (entry: LogEntry) => {
	let line: string;
	try {
		line = JSON.stringify(entry);
	} catch {
		line = JSON.stringify({ severity: entry.severity, message: entry.message, time: entry.time });
	}
	try {
		sink(line, entry.severity);
	} catch {
		// Logging must never break a request.
	}
};

const at =
	(severity: Severity) =>
	(message: string, ...args: unknown[]) =>
		writeEntry(buildLogEntry(severity, message, args));

export const log = {
	debug: at("DEBUG"),
	info: at("INFO"),
	notice: at("NOTICE"),
	warn: at("WARNING"),
	error: at("ERROR"),
	critical: at("CRITICAL"),
};

export default log;
