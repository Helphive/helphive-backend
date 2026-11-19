// Validation of saved analytics views (pure): a name and a whitelisted Explorer query.
import { BREAKDOWNS, metricById } from "./metrics";
import { INTERVALS, parseDay } from "./periods";
import { AnalyticsQueryError, RANGE_PRESETS } from "./query";
import { STATS } from "./compute";

export const CHART_TYPES = ["line", "bar", "area", "table"] as const;
export const MAX_VIEWS_PER_ADMIN = 100;

export interface ViewQuery {
	metric: string;
	breakdown: string | null;
	range: string | null;
	from: string | null;
	to: string | null;
	interval: string | null;
	compare: string | null;
	stat: string | null;
	chart: string | null;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

export const parseViewName = (value: unknown): string => {
	if (typeof value !== "string") throw new AnalyticsQueryError("name must be text.", "name");
	const name = value.trim().replace(/\s+/g, " ");
	if (!name || name.length > 80 || CONTROL.test(name))
		throw new AnalyticsQueryError("name must be 1 to 80 characters.", "name");
	return name;
};

const optional = (q: Record<string, unknown>, key: string, ok: (v: string) => boolean): string | null => {
	const v = q[key];
	if (v === undefined || v === null || v === "") return null;
	if (typeof v !== "string" || v.length > 40 || !ok(v))
		throw new AnalyticsQueryError(`query.${key} is not a valid value.`, `query.${key}`);
	return v;
};

const KEYS = ["metric", "breakdown", "range", "from", "to", "interval", "compare", "stat", "chart"];

export const parseViewQuery = (value: unknown): ViewQuery => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AnalyticsQueryError("query must be an object.", "query");
	const q = value as Record<string, unknown>;
	for (const key of Object.keys(q)) {
		if (!KEYS.includes(key)) throw new AnalyticsQueryError(`Unknown field query.${key.slice(0, 40)}.`, "query");
	}
	const metric = typeof q.metric === "string" ? metricById(q.metric) : undefined;
	if (!metric) throw new AnalyticsQueryError("query.metric must be a known metric.", "query.metric");
	const breakdown = optional(
		q,
		"breakdown",
		(v) => v in BREAKDOWNS && (metric.breakdowns as readonly string[]).includes(v),
	);
	const range = optional(q, "range", (v) => [...RANGE_PRESETS, "custom"].includes(v));
	const from = optional(q, "from", (v) => !!parseDay(v));
	const to = optional(q, "to", (v) => !!parseDay(v));
	if ((from === null) !== (to === null))
		throw new AnalyticsQueryError("query.from and query.to go together.", "query.from");
	if (from && to && from > to)
		throw new AnalyticsQueryError("query.from must be on or before query.to.", "query.from");
	return {
		metric: metric.id,
		breakdown,
		range: from ? "custom" : range,
		from,
		to,
		interval: optional(q, "interval", (v) => [...INTERVALS, "auto"].includes(v)),
		compare: optional(q, "compare", (v) => v === "none" || v === "previous"),
		stat: optional(q, "stat", (v) => (STATS as readonly string[]).includes(v)),
		chart: optional(q, "chart", (v) => (CHART_TYPES as readonly string[]).includes(v)),
	};
};

/** Body of POST (name, query, shared?) or PATCH (any of them, at least one). Unknown fields are refused. */
export const parseViewBody = (body: unknown, partial: boolean) => {
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new AnalyticsQueryError("Send a JSON object.", "body");
	const b = body as Record<string, unknown>;
	for (const key of Object.keys(b)) {
		if (!["name", "query", "shared"].includes(key))
			throw new AnalyticsQueryError(`Unknown field ${key.slice(0, 40)}.`, key);
	}
	if (b.shared !== undefined && typeof b.shared !== "boolean")
		throw new AnalyticsQueryError("shared must be true or false.", "shared");
	const out: { name?: string; query?: ViewQuery; shared?: boolean } = {};
	if (b.name !== undefined || !partial) out.name = parseViewName(b.name);
	if (b.query !== undefined || !partial) out.query = parseViewQuery(b.query);
	if (b.shared !== undefined) out.shared = b.shared as boolean;
	if (partial && !Object.keys(out).length) throw new AnalyticsQueryError("Send name, query or shared.", "body");
	return out;
};
