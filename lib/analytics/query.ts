// Query validation for the analytics endpoints (pure). Every parameter is checked against a whitelist: a single
// string, at most 100 characters, no control characters, from a known set or a strict pattern. Anything else is an
// AnalyticsQueryError naming the field (answered 400 { message, field }).
import { parseTimeZone, TimeZoneError } from "../operations";
import { BREAKDOWNS, METRIC_IDS, metricById, type Breakdown, type MetricDef } from "./metrics";
import {
	addDays,
	compareDays,
	dayIn,
	EARLIEST_DAY,
	formatDay,
	INTERVALS,
	parseDay,
	PeriodError,
	resolveRange,
	type Day,
	type Interval,
	type ResolvedRange,
} from "./periods";
import { STATS, type Stat } from "./compute";

export class AnalyticsQueryError extends Error {
	constructor(
		message: string,
		readonly field: string,
	) {
		super(message);
	}
}

export const RANGE_PRESETS = ["7d", "30d", "90d", "12m", "ytd", "all"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const CONTROL = /[\u0000-\u001f\u007f]/;

/** The query as single strings, refusing unknown names, arrays, objects, overlong or control-character values. */
export const takeStrings = (query: Record<string, unknown>, allowed: readonly string[]) => {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(query ?? {})) {
		if (!allowed.includes(name)) throw new AnalyticsQueryError(`Unknown parameter ${name.slice(0, 40)}.`, name);
		if (typeof value !== "string") throw new AnalyticsQueryError(`${name} must be given once, as text.`, name);
		if (value.length > 100 || CONTROL.test(value))
			throw new AnalyticsQueryError(`${name} is not a valid value.`, name);
		out[name] = value;
	}
	return out;
};

export const oneOf = <T extends string>(
	params: Record<string, string>,
	name: string,
	values: readonly T[],
	fallback: T,
): T => {
	const value = params[name];
	if (value === undefined || value === "") return fallback;
	if (!(values as readonly string[]).includes(value))
		throw new AnalyticsQueryError(`${name} must be one of ${values.join(", ")}.`, name);
	return value as T;
};

export const intParam = (params: Record<string, string>, name: string, min: number, max: number, fallback: number) => {
	const value = params[name];
	if (value === undefined || value === "") return fallback;
	if (!/^\d{1,4}$/.test(value) || Number(value) < min || Number(value) > max)
		throw new AnalyticsQueryError(`${name} must be a whole number from ${min} to ${max}.`, name);
	return Number(value);
};

export const timeZoneParam = (params: Record<string, string>) => {
	try {
		return parseTimeZone(params.tz);
	} catch (error) {
		if (error instanceof TimeZoneError) throw new AnalyticsQueryError(error.message, "tz");
		throw error;
	}
};

export interface RangeRequest {
	preset: RangePreset | "custom";
	from?: Day;
	to?: Day;
}

/** `range` preset, or `from` and `to` (YYYY-MM-DD, inclusive) together. Default 30 days. */
export const rangeParam = (params: Record<string, string>): RangeRequest => {
	const hasFrom = !!params.from;
	const hasTo = !!params.to;
	if (hasFrom || hasTo) {
		if (params.range && params.range !== "custom")
			throw new AnalyticsQueryError("Give either range or from and to.", "range");
		if (!hasFrom || !hasTo) throw new AnalyticsQueryError("from and to go together.", hasFrom ? "to" : "from");
		const from = parseDay(params.from);
		if (!from) throw new AnalyticsQueryError("from must be a date (YYYY-MM-DD).", "from");
		const to = parseDay(params.to);
		if (!to) throw new AnalyticsQueryError("to must be a date (YYYY-MM-DD).", "to");
		if (compareDays(from, to) > 0) throw new AnalyticsQueryError("from must be on or before to.", "from");
		if (compareDays(from, parseDay(EARLIEST_DAY)!) < 0)
			throw new AnalyticsQueryError(`from must be on or after ${EARLIEST_DAY}.`, "from");
		return { preset: "custom", from, to };
	}
	return { preset: oneOf(params, "range", RANGE_PRESETS, "30d") };
};

/**
 * The calendar days a range request covers, in `tz` on the day `now` falls on. "all" starts at `earliest` (the first
 * record), "ytd" on 1 January. A custom `to` after today is cut to today.
 */
export const rangeDays = (req: RangeRequest, now: Date, tz: string, earliest?: Day | null) => {
	const today = dayIn(now.getTime(), tz);
	if (req.preset === "custom") {
		const to = compareDays(req.to!, today) > 0 ? today : req.to!;
		return { fromDay: compareDays(req.from!, to) > 0 ? to : req.from!, toDay: to };
	}
	switch (req.preset) {
		case "7d":
			return { fromDay: addDays(today, -6), toDay: today };
		case "30d":
			return { fromDay: addDays(today, -29), toDay: today };
		case "90d":
			return { fromDay: addDays(today, -89), toDay: today };
		case "12m":
			return { fromDay: addDays({ year: today.year - 1, month: today.month, day: today.day }, 1), toDay: today };
		case "ytd":
			return { fromDay: { year: today.year, month: 1, day: 1 }, toDay: today };
		case "all": {
			const first = earliest && compareDays(earliest, today) <= 0 ? earliest : today;
			const floor = parseDay(EARLIEST_DAY)!;
			return { fromDay: compareDays(first, floor) < 0 ? floor : first, toDay: today };
		}
	}
};

/** The interval to use when none is given: days up to ~3 months, weeks up to ~a year, then months. */
export const autoInterval = (days: number): Interval => (days <= 92 ? "day" : days <= 370 ? "week" : "month");

export const resolveOrThrow = (fromDay: Day, toDay: Day, tz: string, interval: Interval): ResolvedRange => {
	try {
		return resolveRange(fromDay, toDay, tz, interval);
	} catch (error) {
		if (error instanceof PeriodError) throw new AnalyticsQueryError(error.message, error.field);
		throw error;
	}
};

export interface SeriesQuery {
	metric: MetricDef;
	range: RangeRequest;
	interval: Interval | "auto";
	tz: string;
	compare: "none" | "previous";
	breakdown: Breakdown | null;
	stat: Stat;
}

export const SERIES_PARAMS = ["metric", "range", "from", "to", "interval", "tz", "compare", "breakdown", "stat"];

export const parseSeriesQuery = (query: Record<string, unknown>): SeriesQuery => {
	const params = takeStrings(query, SERIES_PARAMS);
	if (!params.metric) throw new AnalyticsQueryError("metric is required.", "metric");
	const metric = metricById(params.metric);
	if (!metric) throw new AnalyticsQueryError("Unknown metric.", "metric");
	const breakdown = params.breakdown
		? oneOf(params, "breakdown", Object.keys(BREAKDOWNS) as Breakdown[], "service")
		: null;
	if (breakdown && !metric.breakdowns.includes(breakdown)) {
		throw new AnalyticsQueryError(
			metric.breakdowns.length
				? `${metric.label} can be broken down by ${metric.breakdowns.join(", ")}.`
				: `${metric.label} has no breakdowns.`,
			"breakdown",
		);
	}
	return {
		metric,
		range: rangeParam(params),
		interval: oneOf(params, "interval", [...INTERVALS, "auto"] as const, "auto"),
		tz: timeZoneParam(params),
		compare: oneOf(params, "compare", ["none", "previous"] as const, "none"),
		breakdown,
		stat: oneOf(params, "stat", STATS, "p50"),
	};
};

export const DEFAULT_SUMMARY_METRICS = [
	"bookings_created",
	"bookings_paid",
	"paid_value",
	"platform_fees",
	"fill_rate",
	"time_to_accept",
	"bookings_cancelled",
	"new_customers",
];
export const MAX_SUMMARY_METRICS = 24;

export interface SummaryQuery {
	metrics: MetricDef[];
	range: RangeRequest;
	interval: Interval | "auto";
	tz: string;
}

export const parseSummaryQuery = (query: Record<string, unknown>): SummaryQuery => {
	const params = takeStrings(query, ["metrics", "range", "from", "to", "interval", "tz"]);
	const ids = params.metrics ? params.metrics.split(",").map((s) => s.trim()) : DEFAULT_SUMMARY_METRICS;
	if (!ids.length || ids.length > MAX_SUMMARY_METRICS)
		throw new AnalyticsQueryError(`metrics lists 1 to ${MAX_SUMMARY_METRICS} metrics.`, "metrics");
	const metrics = [...new Set(ids)].map((id) => {
		const def = metricById(id);
		if (!def) throw new AnalyticsQueryError(`Unknown metric ${id.slice(0, 40)}.`, "metrics");
		return def;
	});
	return {
		metrics,
		range: rangeParam(params),
		interval: oneOf(params, "interval", [...INTERVALS, "auto"] as const, "auto"),
		tz: timeZoneParam(params),
	};
};

/** A stable key for the cache: the parsed query in a fixed order (not the raw string, so equivalent URLs share). */
export const cacheKey = (kind: string, parts: Record<string, unknown>) =>
	`${kind}|${Object.keys(parts)
		.sort()
		.map((k) => `${k}=${JSON.stringify(parts[k])}`)
		.join("&")}`;

export const dayString = formatDay;
export { METRIC_IDS };
