// Statistics for analytics (pure): percentiles, distributions and histograms, deltas, retention cohorts and funnels.

/** Percentile `p` (0-100) of ascending values, linearly interpolated between ranks (R-7); null when empty. */
export const percentile = (sorted: readonly number[], p: number): number | null => {
	if (!sorted.length) return null;
	if (sorted.length === 1) return sorted[0];
	const rank = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
};

const finite = (values: readonly unknown[]) =>
	values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);

export const round = (value: number | null, places = 2) =>
	value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places;

export interface Distribution {
	count: number;
	mean: number | null;
	p50: number | null;
	p90: number | null;
	min: number | null;
	max: number | null;
}

export const distribution = (values: readonly unknown[]): Distribution => {
	const v = finite(values);
	return {
		count: v.length,
		mean: v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null,
		p50: round(percentile(v, 50)),
		p90: round(percentile(v, 90)),
		min: v.length ? round(v[0]) : null,
		max: v.length ? round(v[v.length - 1]) : null,
	};
};

/** A step of 1, 2 or 5 times a power of ten that splits `span` into at most `maxBins` bins. */
export const niceStep = (span: number, maxBins: number) => {
	if (!(span > 0)) return 1;
	const raw = span / Math.max(1, maxBins);
	const power = 10 ** Math.floor(Math.log10(raw));
	for (const m of [1, 2, 5, 10]) if (m * power >= raw) return m * power;
	return 10 * power;
};

export interface Bin {
	from: number;
	to: number;
	count: number;
}

/** Equal-width bins on round boundaries covering every value (the last bin includes its upper edge). */
export const histogram = (values: readonly unknown[], maxBins = 12): Bin[] => {
	const v = finite(values);
	if (!v.length) return [];
	const step = niceStep(v[v.length - 1] - v[0], maxBins);
	const first = Math.floor(v[0] / step) * step;
	const count = Math.max(1, Math.floor((v[v.length - 1] - first) / step) + 1);
	const bins: Bin[] = Array.from({ length: count }, (_, i) => ({
		from: round(first + i * step, 6)!,
		to: round(first + (i + 1) * step, 6)!,
		count: 0,
	}));
	for (const x of v) bins[Math.min(count - 1, Math.floor((x - first) / step))].count++;
	return bins;
};

export interface Delta {
	current: number | null;
	previous: number | null;
	change: number | null;
	/** Percentage change, one decimal; null when there is no previous value or it is 0. */
	changePct: number | null;
}

export const delta = (current: number | null, previous: number | null): Delta => {
	if (current === null || previous === null) return { current, previous, change: null, changePct: null };
	const change = round(current - previous, 4);
	return {
		current,
		previous,
		change,
		changePct: previous === 0 ? null : round(((current - previous) / Math.abs(previous)) * 100, 1),
	};
};

export interface CohortRow {
	/** "YYYY-MM" of the first activity. */
	cohort: string;
	size: number;
	/** cells[k]: members active k months after their first month (k = 0 is the first month itself). */
	cells: { offset: number; count: number; rate: number | null }[];
}

/**
 * Retention cohorts from (subject, month) activity pairs. A subject's cohort is its earliest month (over all pairs
 * given, so history before the range still decides it); only cohorts listed in `cohortMonths` are returned, with one
 * cell per month up to the last month in `allMonths`.
 */
export const cohortMatrix = (
	pairs: readonly { id: string; month: string }[],
	cohortMonths: readonly string[],
	lastMonth: string,
): CohortRow[] => {
	const months = new Map<string, Set<string>>();
	for (const { id, month } of pairs) {
		let set = months.get(id);
		if (!set) months.set(id, (set = new Set()));
		set.add(month);
	}
	const index = (m: string) => {
		const [y, mo] = m.split("-").map(Number);
		return y * 12 + (mo - 1);
	};
	const wanted = new Set(cohortMonths);
	const rows = new Map<string, { size: number; counts: number[] }>();
	for (const set of months.values()) {
		const sorted = [...set].sort();
		const first = sorted[0];
		if (!wanted.has(first)) continue;
		let row = rows.get(first);
		if (!row) rows.set(first, (row = { size: 0, counts: [] }));
		row.size++;
		for (const m of sorted) {
			const k = index(m) - index(first);
			if (m > lastMonth) continue;
			row.counts[k] = (row.counts[k] ?? 0) + 1;
		}
	}
	return cohortMonths.map((cohort) => {
		const row = rows.get(cohort);
		const span = index(lastMonth) - index(cohort) + 1;
		return {
			cohort,
			size: row?.size ?? 0,
			cells: Array.from({ length: Math.max(0, span) }, (_, k) => {
				const count = row?.counts[k] ?? 0;
				return { offset: k, count, rate: row?.size ? round((count / row.size) * 100, 1) : null };
			}),
		};
	});
};

export interface FunnelStep {
	id: string;
	label: string;
}

export interface FunnelResult {
	id: string;
	label: string;
	count: number;
	/** Percent of the first step. */
	fromStart: number | null;
	/** Percent of the previous step. */
	fromPrevious: number | null;
}

/**
 * Strict funnel: a subject counts at a step only if it reached that step and every step before it. `groups` are
 * subjects grouped by which steps they reached (flags in step order) with a count, as the database returns them.
 */
export const funnel = (
	steps: readonly FunnelStep[],
	groups: readonly { reached: readonly boolean[]; count: number }[],
): FunnelResult[] => {
	const counts = steps.map(() => 0);
	for (const g of groups) {
		for (let i = 0; i < steps.length; i++) {
			if (!g.reached[i]) break;
			counts[i] += g.count;
		}
	}
	return steps.map((s, i) => ({
		id: s.id,
		label: s.label,
		count: counts[i],
		fromStart: counts[0] ? round((counts[i] / counts[0]) * 100, 1) : null,
		fromPrevious: i === 0 ? null : counts[i - 1] ? round((counts[i] / counts[i - 1]) * 100, 1) : null,
	}));
};
