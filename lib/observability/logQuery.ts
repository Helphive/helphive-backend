// The log explorer's query: validation of what the console sends, the Cloud Logging filter built from it, links to
// the same query in the Google Cloud console, and the compact shape returned for each entry. Pure.
import { ListQueryError } from "../listQuery";

export const SEVERITIES = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"] as const;
export type LogSeverity = (typeof SEVERITIES)[number];

export const MAX_LOG_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_RANGE_MS = 60 * 60 * 1000;
export const MAX_LOG_PAGE_SIZE = 200;

export interface LogQuery {
	from: Date;
	to: Date;
	severity?: LogSeverity;
	requestId?: string;
	route?: string;
	userId?: string;
	text?: string;
	pageSize: number;
	pageToken?: string;
}

const REQUEST_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{7,63}$/;
const ROUTE = /^\/[A-Za-z0-9_\-/:.*()]{0,199}$/;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const PAGE_TOKEN = /^[A-Za-z0-9_\-=+/]{1,2048}$/;
const ALLOWED = new Set(["from", "to", "severity", "requestId", "route", "userId", "text", "pageSize", "pageToken"]);

const single = (query: Record<string, unknown>, name: string): string | undefined => {
	const value = query[name];
	if (value === undefined || value === "") return undefined;
	if (typeof value !== "string") throw new ListQueryError(`${name} must be given once, as text.`, name);
	return value;
};

const time = (value: string, name: string) => {
	const date = new Date(value);
	if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(date.getTime())) {
		throw new ListQueryError(`${name} must be an ISO date or time.`, name);
	}
	return date;
};

/** Validates the explorer's query string. Unknown parameters, arrays and malformed values answer 400. */
export const parseLogQuery = (query: Record<string, unknown>, now = new Date()): LogQuery => {
	for (const key of Object.keys(query)) {
		if (!ALLOWED.has(key)) throw new ListQueryError(`Unknown parameter ${key}.`, key);
	}
	const toText = single(query, "to");
	const fromText = single(query, "from");
	const to = toText ? time(toText, "to") : now;
	const from = fromText ? time(fromText, "from") : new Date(to.getTime() - DEFAULT_LOG_RANGE_MS);
	if (from >= to) throw new ListQueryError("from must be before to.", "from");
	if (to.getTime() - from.getTime() > MAX_LOG_RANGE_MS) {
		throw new ListQueryError("The range can be at most 30 days (Cloud Logging keeps 30 days).", "from");
	}
	const severity = single(query, "severity")?.toUpperCase();
	if (severity && !(SEVERITIES as readonly string[]).includes(severity)) {
		throw new ListQueryError(`severity must be one of: ${SEVERITIES.join(", ")}.`, "severity");
	}
	const requestId = single(query, "requestId");
	if (requestId && !REQUEST_ID.test(requestId)) throw new ListQueryError("Invalid request id.", "requestId");
	const route = single(query, "route");
	if (route && !ROUTE.test(route))
		throw new ListQueryError("route must be a path such as /admin/users/:id.", "route");
	const userId = single(query, "userId");
	if (userId && !OBJECT_ID.test(userId)) throw new ListQueryError("userId must be a user or admin id.", "userId");
	const text = single(query, "text");
	if (text && (text.length > 100 || /[\u0000-\u001f]/.test(text))) {
		throw new ListQueryError("Search text can be at most 100 characters.", "text");
	}
	const sizeText = single(query, "pageSize");
	const pageSize = sizeText === undefined ? 50 : Number(sizeText);
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_LOG_PAGE_SIZE) {
		throw new ListQueryError(`pageSize must be 1 to ${MAX_LOG_PAGE_SIZE}.`, "pageSize");
	}
	const pageToken = single(query, "pageToken");
	if (pageToken && !PAGE_TOKEN.test(pageToken)) throw new ListQueryError("Invalid page token.", "pageToken");
	return {
		from,
		to,
		...(severity ? { severity: severity as LogSeverity } : {}),
		...(requestId ? { requestId } : {}),
		...(route ? { route } : {}),
		...(userId ? { userId } : {}),
		...(text ? { text } : {}),
		pageSize,
		...(pageToken ? { pageToken } : {}),
	};
};

/** A string literal in the Logging query language. */
export const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export interface LogTarget {
	project: string;
	/** Cloud Run service name (K_SERVICE); omitted locally. */
	service?: string;
}

/** The Cloud Logging filter for a query. Time bounds included, so the console link shows the same entries. */
export const buildLogFilter = (query: LogQuery, target: LogTarget): string => {
	const lines = [`resource.type="cloud_run_revision"`];
	if (target.service) lines.push(`resource.labels.service_name=${quote(target.service)}`);
	lines.push(`timestamp>=${quote(query.from.toISOString())}`, `timestamp<=${quote(query.to.toISOString())}`);
	if (query.severity) lines.push(`severity>=${query.severity}`);
	if (query.requestId) lines.push(`jsonPayload.requestId=${quote(query.requestId)}`);
	if (query.route) lines.push(`jsonPayload.route=${quote(query.route)}`);
	if (query.userId) {
		lines.push(`(jsonPayload.userId=${quote(query.userId)} OR jsonPayload.adminId=${quote(query.userId)})`);
	}
	if (query.text) lines.push(quote(query.text));
	return lines.join("\n");
};

/** The same query in the Logs Explorer. */
export const logsConsoleLink = (filter: string, project: string, from?: Date, to?: Date) => {
	const range = from && to ? `;startTime=${from.toISOString()};endTime=${to.toISOString()}` : "";
	return `https://console.cloud.google.com/logs/query;query=${encodeURIComponent(filter)}${range}?project=${encodeURIComponent(project)}`;
};

/** Logs Explorer link for one request id (around a time when known). */
export const requestLogsLink = (requestId: string, target: LogTarget, around?: Date | null) => {
	const at = around ?? new Date();
	const from = new Date(at.getTime() - 15 * 60 * 1000);
	const to = new Date(at.getTime() + 15 * 60 * 1000);
	const filter = buildLogFilter({ from, to, requestId, pageSize: 50 }, target);
	return logsConsoleLink(filter, target.project, from, to);
};

/** Trace Explorer link from a trace field ("projects/<p>/traces/<id>"). */
export const traceLink = (trace: string | null | undefined, project: string) => {
	const match = /traces\/([0-9a-f]{32})$/i.exec(trace ?? "");
	return match
		? `https://console.cloud.google.com/traces/list?project=${encodeURIComponent(project)}&tid=${match[1]}`
		: null;
};

export interface CompactLogEntry {
	id: string;
	timestamp: string | null;
	severity: string;
	message: string;
	/** The standard `event` name (null on lines written before the logging standard and on platform lines). */
	event: string | null;
	/** The visitor's Cloudflare ray, when the request came through the edge. */
	ray: string | null;
	requestId: string | null;
	route: string | null;
	userId: string | null;
	adminId: string | null;
	appPlatform: string | null;
	appVersion: string | null;
	revision: string | null;
	http: { method: string; url: string; status: number | null; latencyMs: number | null } | null;
	error: { name: string | null; message: string | null; stack: string | null } | null;
	details: unknown;
	trace: string | null;
	traceUrl: string | null;
	logName: string | null;
}

const str = (value: unknown, max = 4000) => (typeof value === "string" ? value.slice(0, max) : null);

const latencyMs = (value: unknown) => {
	if (typeof value === "string") {
		const seconds = Number.parseFloat(value.replace(/s$/, ""));
		return Number.isFinite(seconds) ? Math.round(seconds * 10000) / 10 : null;
	}
	if (value && typeof value === "object") {
		const { seconds, nanos } = value as { seconds?: unknown; nanos?: unknown };
		const total = Number(seconds ?? 0) * 1000 + Number(nanos ?? 0) / 1e6;
		return Number.isFinite(total) ? Math.round(total * 10) / 10 : null;
	}
	return null;
};

/**
 * The HTTP summary of an entry: Cloud Run's own request log (`httpRequest`), the API's `request` lines (method,
 * route, status, ms per the logging standard), or the older `httpRequest` inside the payload.
 */
const httpOf = (raw: Record<string, any>, payload: Record<string, any>) => {
	if (raw.httpRequest) return raw.httpRequest as Record<string, any>;
	if (payload.event === "request" && typeof payload.method === "string") {
		return {
			requestMethod: payload.method,
			requestUrl: payload.route ?? "",
			status: payload.status,
			latency: typeof payload.ms === "number" ? `${payload.ms / 1000}s` : undefined,
		};
	}
	return (payload.httpRequest ?? null) as Record<string, any> | null;
};

/** One Cloud Logging entry in the shape the console shows. Accepts JSON and text payloads (and platform lines). */
export const compactLogEntry = (raw: Record<string, any>, project: string): CompactLogEntry => {
	const payload = (raw.jsonPayload ?? {}) as Record<string, any>;
	const http = httpOf(raw, payload);
	const trace = str(raw.trace) ?? str(payload["logging.googleapis.com/trace"]);
	const error = payload.error && typeof payload.error === "object" ? payload.error : null;
	const message =
		str(payload.msg) ??
		str(payload.message) ??
		str(raw.textPayload) ??
		(http ? `${http.requestMethod ?? ""} ${http.requestUrl ?? ""} ${http.status ?? ""}`.trim() : "") ??
		"";
	return {
		id: String(raw.insertId ?? ""),
		timestamp: str(raw.timestamp),
		severity: String(raw.severity ?? "DEFAULT"),
		message: message ?? "",
		event: str(payload.event, 80),
		ray: str(payload.ray, 40),
		requestId: str(payload.requestId, 100),
		route: str(payload.route, 200),
		userId: str(payload.userId, 40),
		adminId: str(payload.adminId, 40),
		appPlatform: str(payload.appPlatform, 40),
		appVersion: str(payload.appVersion, 40),
		revision: str(raw.resource?.labels?.revision_name, 100),
		http: http
			? {
					method: String(http.requestMethod ?? ""),
					url: String(http.requestUrl ?? "").slice(0, 500),
					status: Number.isFinite(Number(http.status)) ? Number(http.status) : null,
					latencyMs: latencyMs(http.latency),
				}
			: null,
		error: error
			? { name: str(error.name, 200), message: str(error.message), stack: str(error.stack, 8000) }
			: null,
		details: payload.details ?? null,
		trace,
		traceUrl: traceLink(trace, project),
		logName: str(raw.logName, 300),
	};
};
