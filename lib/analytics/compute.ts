// Turning grouped pipeline rows into values (pure): one value per bucket and series, the range total, top-N
// breakdowns with "Other", derived metrics and the repeat-booking rate.
import type { AggregateMetric, MetricDef } from "./metrics";
import { MAX_BREAKDOWN_SERIES } from "./metrics";
import { bucketIndex, type ResolvedRange } from "./periods";
import { percentile, round } from "./stats";

export interface Parts {
	n: number;
	s: number;
	c: number;
	d: number;
	vals: number[];
	ids: Set<string>;
}

export interface Row {
	t: Date | string | number | null;
	k: unknown;
	n?: number;
	s?: number;
	c?: number;
	d?: number;
	vals?: unknown[];
	ids?: unknown[];
}

export const STATS = ["p50", "p90", "mean"] as const;
export type Stat = (typeof STATS)[number];

export const emptyParts = (): Parts => ({ n: 0, s: 0, c: 0, d: 0, vals: [], ids: new Set() });

export const addRow = (p: Parts, row: Row): Parts => {
	p.n += Number(row.n) || 0;
	p.s += Number(row.s) || 0;
	p.c += Number(row.c) || 0;
	p.d += Number(row.d) || 0;
	for (const v of row.vals ?? []) if (typeof v === "number" && Number.isFinite(v)) p.vals.push(v);
	for (const id of row.ids ?? []) if (id !== null && id !== undefined) p.ids.add(String(id));
	return p;
};

export const mergeParts = (a: Parts, b: Parts): Parts => {
	const out = emptyParts();
	for (const p of [a, b]) {
		out.n += p.n;
		out.s += p.s;
		out.c += p.c;
		out.d += p.d;
		out.vals.push(...p.vals);
		for (const id of p.ids) out.ids.add(id);
	}
	return out;
};

const moneyOrNumber = (def: AggregateMetric, v: number | null) =>
	v === null ? null : round(v * (def.scale ?? 1), def.unit === "count" ? 0 : 2);

/** The value of a metric from its parts. Rates and means are null when nothing was counted. */
export const valueOf = (def: AggregateMetric, p: Parts, stat: Stat = "p50"): number | null => {
	switch (def.op) {
		case "count":
			return p.n;
		case "sum":
			return moneyOrNumber(def, p.s);
		case "mean":
			return p.c ? moneyOrNumber(def, p.s / p.c) : null;
		case "ratio":
			return p.d ? round((p.s / p.d) * (def.scale ?? 1), 1) : null;
		case "distinct":
			return p.ids.size;
		case "perDistinct":
			return p.ids.size ? round(p.s / p.ids.size, 2) : null;
		case "dist": {
			if (!p.vals.length) return null;
			const sorted = [...p.vals].sort((a, b) => a - b);
			if (stat === "mean") return round(sorted.reduce((a, b) => a + b, 0) / sorted.length, 0);
			return round(percentile(sorted, stat === "p90" ? 90 : 50), 0);
		}
	}
};

/** The value a bucket with no rows shows: 0 for counts and sums, null (no data) for rates and averages. */
export const emptyValue = (def: MetricDef): number | null =>
	def.kind === "aggregate" && (def.op === "count" || def.op === "sum" || def.op === "distinct") ? 0 : null;

export interface SeriesOut {
	key: string;
	label: string;
	values: (number | null)[];
	total: number | null;
}

export interface Assembled {
	series: SeriesOut[];
	/** All series together, per bucket. */
	values: (number | null)[];
	total: number | null;
	/** Documents counted in the range (all series). */
	count: number;
}

const keyOf = (k: unknown) => (k === null || k === undefined ? "all" : String(k));

/**
 * Assembles rows into series over the range's buckets. With a breakdown, the largest MAX_BREAKDOWN_SERIES keys (by
 * documents counted) are kept and the rest merged into "other". `totalRows` (rows grouped over the whole range) give
 * exact totals for distinct counts, which cannot be added up across buckets.
 */
export const assemble = (
	def: AggregateMetric,
	range: ResolvedRange,
	rows: readonly Row[],
	stat: Stat = "p50",
	totalRows?: readonly Row[],
): Assembled => {
	const byKey = new Map<string, Parts[]>();
	const totals = new Map<string, Parts>();
	const overall = range.buckets.map(() => emptyParts());
	const overallTotal = emptyParts();
	for (const row of rows) {
		const i = row.t === null ? -1 : bucketIndex(range, new Date(row.t).getTime());
		if (i < 0) continue;
		const key = keyOf(row.k);
		let parts = byKey.get(key);
		if (!parts) byKey.set(key, (parts = range.buckets.map(() => emptyParts())));
		addRow(parts[i], row);
		addRow(overall[i], row);
		if (!totalRows) {
			addRow(totals.get(key) ?? totals.set(key, emptyParts()).get(key)!, row);
			addRow(overallTotal, row);
		}
	}
	if (totalRows) {
		for (const row of totalRows) {
			const key = keyOf(row.k);
			addRow(totals.get(key) ?? totals.set(key, emptyParts()).get(key)!, row);
			addRow(overallTotal, row);
		}
	}

	const ranked = [...byKey.keys()].sort(
		(a, b) => (totals.get(b)?.n ?? 0) - (totals.get(a)?.n ?? 0) || (a < b ? -1 : 1),
	);
	const kept = ranked.slice(0, MAX_BREAKDOWN_SERIES);
	const rest = ranked.slice(MAX_BREAKDOWN_SERIES);
	const empty = emptyValue(def);
	const toValues = (parts: Parts[]) => parts.map((p) => (p.n ? valueOf(def, p, stat) : empty));
	const series: SeriesOut[] = kept.map((key) => ({
		key,
		label: key,
		values: toValues(byKey.get(key)!),
		total: valueOf(def, totals.get(key) ?? emptyParts(), stat),
	}));
	if (rest.length) {
		const parts = range.buckets.map((_, i) =>
			rest.reduce((acc, key) => mergeParts(acc, byKey.get(key)![i]), emptyParts()),
		);
		const total = rest.reduce((acc, key) => mergeParts(acc, totals.get(key) ?? emptyParts()), emptyParts());
		series.push({
			key: "other",
			label: `Other (${rest.length})`,
			values: toValues(parts),
			total: valueOf(def, total, stat),
		});
	}
	return {
		series,
		values: toValues(overall),
		total: overallTotal.n ? valueOf(def, overallTotal, stat) : empty,
		count: overallTotal.n,
	};
};

/** A derived metric's values from its inputs' assembled values (bucket by bucket, and for the totals). */
export const combineDerived = (
	combine: (values: (number | null)[], ctx: { approvedProviders?: number }) => number | null,
	inputs: readonly Assembled[],
	ctx: { approvedProviders?: number } = {},
	places = 2,
) => {
	const length = inputs[0]?.values.length ?? 0;
	const values = Array.from({ length }, (_, i) =>
		round(
			combine(
				inputs.map((x) => x.values[i]),
				ctx,
			),
			places,
		),
	);
	const total = round(
		combine(
			inputs.map((x) => x.total),
			ctx,
		),
		places,
	);
	return { values, total };
};

/**
 * Repeat-booking rate per bucket. `customers` lists, per customer, the first booking ever (before or in the range)
 * and the times of their bookings inside the range. A customer counts as active in a bucket with a booking in it,
 * and as repeat when their first booking ever is before that booking (earlier bucket, earlier in the same bucket,
 * or a second booking in the bucket).
 */
export const repeatRates = (
	range: ResolvedRange,
	customers: readonly { first: Date | number; inRange: readonly (Date | number)[] }[],
) => {
	const active = range.buckets.map(() => 0);
	const repeat = range.buckets.map(() => 0);
	let activeTotal = 0;
	let repeatTotal = 0;
	for (const c of customers) {
		const first = new Date(c.first).getTime();
		const perBucket = new Map<number, number[]>();
		for (const at of c.inRange) {
			const t = new Date(at).getTime();
			const i = bucketIndex(range, t);
			if (i < 0) continue;
			perBucket.set(i, [...(perBucket.get(i) ?? []), t]);
		}
		if (!perBucket.size) continue;
		let anyRepeat = false;
		for (const [i, times] of perBucket) {
			active[i]++;
			if (times.length > 1 || Math.min(...times) > first) {
				repeat[i]++;
				anyRepeat = true;
			}
		}
		activeTotal++;
		const allTimes = [...perBucket.values()].flat();
		if (anyRepeat || allTimes.length > 1 || Math.min(...allTimes) > first) repeatTotal++;
	}
	return {
		values: active.map((a, i) => (a ? round((repeat[i] / a) * 100, 1) : null)),
		total: activeTotal ? round((repeatTotal / activeTotal) * 100, 1) : null,
		active,
		count: activeTotal,
	};
};
