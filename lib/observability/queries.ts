// Read-side aggregation over the request-metrics collection, shared by the endpoints, the alert evaluator and the
// rule preview. Counters are summed by MongoDB; histograms are summed per bucket by a second pipeline and turned
// into percentiles here.
import RequestMetricModel from "../../dal/models/obsRequestMetric.model";
import { ListQueryError } from "../listQuery";
import { percentiles, type Histogram } from "./histogram";

export const RANGES = {
	"1h": { ms: 60 * 60_000, bucketMs: 60_000 },
	"6h": { ms: 6 * 60 * 60_000, bucketMs: 5 * 60_000 },
	"24h": { ms: 24 * 60 * 60_000, bucketMs: 15 * 60_000 },
	"7d": { ms: 7 * 24 * 60 * 60_000, bucketMs: 60 * 60_000 },
	"30d": { ms: 30 * 24 * 60 * 60_000, bucketMs: 6 * 60 * 60_000 },
} as const;
export type RangeName = keyof typeof RANGES;

export interface TimeWindow {
	range: RangeName;
	from: Date;
	to: Date;
	bucketMs: number;
}

/** `range` from a query string (default 24h); `to` is now rounded up to the bucket so series end on a boundary. */
export const parseRange = (value: unknown, fallback: RangeName = "24h", now = Date.now()): TimeWindow => {
	if (value !== undefined && typeof value !== "string")
		throw new ListQueryError("range must be given once.", "range");
	const name = (value || fallback) as RangeName;
	if (!(name in RANGES))
		throw new ListQueryError(`range must be one of: ${Object.keys(RANGES).join(", ")}.`, "range");
	const { ms, bucketMs } = RANGES[name];
	const to = Math.ceil(now / bucketMs) * bucketMs;
	return { range: name, from: new Date(to - ms), to: new Date(to), bucketMs };
};

export interface Totals {
	n: number;
	s2: number;
	s3: number;
	s4: number;
	s5: number;
	rl: number;
	sum: number;
	max: number;
	h: Histogram;
}

export const emptyTotals = (): Totals => ({ n: 0, s2: 0, s3: 0, s4: 0, s5: 0, rl: 0, sum: 0, max: 0, h: {} });

/** Rates and percentiles for a set of totals. */
export const summarize = (t: Totals, minutes: number) => ({
	requests: t.n,
	perMinute: minutes > 0 ? Math.round((t.n / minutes) * 100) / 100 : 0,
	errors: t.s5,
	clientErrors: t.s4,
	rateLimited: t.rl,
	errorRate: t.n ? Math.round((10000 * t.s5) / t.n) / 100 : null,
	avgMs: t.n ? Math.round((t.sum / t.n) * 10) / 10 : null,
	maxMs: t.n ? t.max : null,
	...percentiles(t.h, t.max || null),
	status: { "2xx": t.s2, "3xx": t.s3, "4xx": t.s4, "5xx": t.s5, "429": t.rl },
});

export interface MetricFilter {
	from: Date;
	to: Date;
	route?: string | null;
	method?: string | null;
	revision?: string | null;
}

const match = (f: MetricFilter) => ({
	m: { $gte: f.from, $lt: f.to },
	...(f.route ? { r: f.route } : {}),
	...(f.method ? { mt: f.method } : {}),
	...(f.revision ? { rv: f.revision } : {}),
});

const SUMS = {
	n: { $sum: "$n" },
	s2: { $sum: "$s2" },
	s3: { $sum: "$s3" },
	s4: { $sum: "$s4" },
	s5: { $sum: "$s5" },
	rl: { $sum: "$rl" },
	sum: { $sum: "$sum" },
	max: { $max: "$max" },
};

const bucketOf = (bucketMs: number) => ({
	$toDate: { $subtract: [{ $toLong: "$m" }, { $mod: [{ $toLong: "$m" }, bucketMs] }] },
});

/**
 * Totals grouped by `groupBy` (an expression map: route and method, time bucket, revision...). Returns a map keyed by
 * the JSON of each group id, each with its merged histogram.
 */
export const groupedTotals = async (filter: MetricFilter, groupBy: Record<string, unknown> | null) => {
	const id = groupBy ?? null;
	const timeLimit = { maxTimeMS: 8000 };
	const [sums, buckets] = await Promise.all([
		RequestMetricModel.aggregate([{ $match: match(filter) }, { $group: { _id: id, ...SUMS } }]).option(timeLimit),
		RequestMetricModel.aggregate([
			{ $match: match(filter) },
			{
				$project: {
					...(groupBy ? Object.fromEntries(Object.entries(groupBy).map(([k, v]) => [k, v])) : {}),
					h: { $objectToArray: "$h" },
				},
			},
			{ $unwind: "$h" },
			{
				$group: {
					_id: {
						g: groupBy ? Object.fromEntries(Object.keys(groupBy).map((k) => [k, `$${k}`])) : null,
						b: "$h.k",
					},
					c: { $sum: "$h.v" },
				},
			},
		]).option(timeLimit),
	]);
	const result = new Map<string, { id: any; totals: Totals }>();
	for (const row of sums) {
		const { _id, ...t } = row;
		result.set(JSON.stringify(_id ?? null), { id: _id, totals: { ...emptyTotals(), ...t, h: {} } });
	}
	for (const row of buckets) {
		const key = JSON.stringify(row._id.g ?? null);
		const entry = result.get(key);
		if (entry) entry.totals.h[String(row._id.b)] = (entry.totals.h[String(row._id.b)] ?? 0) + row.c;
	}
	return result;
};

/** One set of totals over the filter. */
export const totalsFor = async (filter: MetricFilter): Promise<Totals> =>
	(await groupedTotals(filter, null)).get("null")?.totals ?? emptyTotals();

/** Series over time, every bucket present (empty ones zero), oldest first. */
export const seriesFor = async (filter: MetricFilter, bucketMs: number) => {
	const grouped = await groupedTotals(filter, { t: bucketOf(bucketMs) });
	const byTime = new Map<number, Totals>();
	for (const { id, totals } of grouped.values()) byTime.set(new Date(id.t).getTime(), totals);
	const points = [];
	const start = Math.floor(filter.from.getTime() / bucketMs) * bucketMs;
	for (let t = start; t < filter.to.getTime(); t += bucketMs) {
		const totals = byTime.get(t) ?? emptyTotals();
		points.push({ t: new Date(t).toISOString(), ...summarize(totals, bucketMs / 60_000) });
	}
	return points;
};

/** Per route and method, with a 24-point request-count sparkline. */
export const routeTable = async (window: TimeWindow) => {
	const sparkMs = Math.max(60_000, Math.floor((window.to.getTime() - window.from.getTime()) / 24 / 60_000) * 60_000);
	const filter = { from: window.from, to: window.to };
	const [byRoute, bySpark] = await Promise.all([
		groupedTotals(filter, { r: "$r", mt: "$mt" }),
		RequestMetricModel.aggregate([
			{ $match: match(filter) },
			{ $group: { _id: { r: "$r", mt: "$mt", t: bucketOf(sparkMs) }, n: { $sum: "$n" }, s5: { $sum: "$s5" } } },
		]).option({ maxTimeMS: 8000 }),
	]);
	const minutes = (window.to.getTime() - window.from.getTime()) / 60_000;
	const start = Math.floor(window.from.getTime() / sparkMs) * sparkMs;
	const points = Math.ceil((window.to.getTime() - start) / sparkMs);
	const sparks = new Map<string, { n: number[]; s5: number[] }>();
	for (const row of bySpark) {
		const key = `${row._id.mt} ${row._id.r}`;
		const entry = sparks.get(key) ?? { n: Array(points).fill(0), s5: Array(points).fill(0) };
		const index = Math.floor((new Date(row._id.t).getTime() - start) / sparkMs);
		if (index >= 0 && index < points) {
			entry.n[index] += row.n;
			entry.s5[index] += row.s5;
		}
		sparks.set(key, entry);
	}
	return [...byRoute.values()]
		.map(({ id, totals }) => ({
			route: id.r as string,
			method: id.mt as string,
			...summarize(totals, minutes),
			spark: sparks.get(`${id.mt} ${id.r}`)?.n ?? [],
			errorSpark: sparks.get(`${id.mt} ${id.r}`)?.s5 ?? [],
		}))
		.sort((a, b) => b.requests - a.requests);
};

/** Per-minute totals (for the rule preview), keyed by minute start. */
export const minuteTotals = async (filter: MetricFilter) => {
	const grouped = await groupedTotals(filter, { t: "$m" });
	const byMinute = new Map<number, Totals>();
	for (const { id, totals } of grouped.values()) byMinute.set(new Date(id.t).getTime(), totals);
	return byMinute;
};
