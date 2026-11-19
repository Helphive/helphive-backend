// Latency histograms with fixed bucket bounds, so histograms from any instance, minute or route merge by adding
// counts. Stored sparse ({ "<bucket index>": count }) because most requests land in a handful of buckets.
// Pure; no I/O.

/** Upper bounds in milliseconds. Bucket i holds (BOUNDS[i-1], BOUNDS[i]]; the last bucket holds everything above. */
export const LATENCY_BOUNDS_MS = [
	5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000,
] as const;

export const BUCKET_COUNT = LATENCY_BOUNDS_MS.length + 1;

export type Histogram = Record<string, number>;

/** Index of the bucket a latency falls in. */
export const bucketFor = (ms: number): number => {
	if (!Number.isFinite(ms) || ms <= LATENCY_BOUNDS_MS[0]) return 0;
	let lo = 0;
	let hi: number = LATENCY_BOUNDS_MS.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ms <= LATENCY_BOUNDS_MS[mid]) hi = mid;
		else lo = mid + 1;
	}
	return lo;
};

export const addToHistogram = (histogram: Histogram, ms: number, count = 1) => {
	const key = String(bucketFor(ms));
	histogram[key] = (histogram[key] ?? 0) + count;
	return histogram;
};

/** Adds histograms bucket by bucket (the merge is exact: same bounds everywhere). Ignores malformed entries. */
export const mergeHistograms = (...histograms: (Histogram | null | undefined)[]): Histogram => {
	const merged: Histogram = {};
	for (const histogram of histograms) {
		if (!histogram) continue;
		for (const [key, value] of Object.entries(histogram)) {
			const index = Number(key);
			if (!Number.isInteger(index) || index < 0 || index >= BUCKET_COUNT) continue;
			if (!Number.isFinite(value) || value <= 0) continue;
			merged[key] = (merged[key] ?? 0) + value;
		}
	}
	return merged;
};

export const histogramCount = (histogram: Histogram | null | undefined) =>
	Object.values(histogram ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);

/**
 * Estimated latency at percentile `p` (0-100): finds the bucket holding that rank and interpolates linearly inside it.
 * The open last bucket is capped at `maxMs` when known (else twice the last bound). Null for an empty histogram.
 * Error is bounded by the bucket width at that rank.
 */
export const percentile = (
	histogram: Histogram | null | undefined,
	p: number,
	maxMs?: number | null,
): number | null => {
	const total = histogramCount(histogram);
	if (!total || !histogram) return null;
	const rank = (Math.min(100, Math.max(0, p)) / 100) * total;
	let seen = 0;
	for (let index = 0; index < BUCKET_COUNT; index++) {
		const count = histogram[String(index)] ?? 0;
		if (count <= 0) continue;
		if (seen + count >= rank) {
			const lower = index === 0 ? 0 : LATENCY_BOUNDS_MS[index - 1];
			const lastBound = LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];
			let upper: number = index < LATENCY_BOUNDS_MS.length ? LATENCY_BOUNDS_MS[index] : lastBound * 2;
			if (maxMs != null && Number.isFinite(maxMs) && maxMs > lower) upper = Math.min(upper, maxMs);
			const within = count ? (rank - seen) / count : 0;
			return Math.round((lower + (upper - lower) * Math.min(1, Math.max(0, within))) * 10) / 10;
		}
		seen += count;
	}
	return null;
};

/** p50, p95 and p99 at once. */
export const percentiles = (histogram: Histogram | null | undefined, maxMs?: number | null) => ({
	p50: percentile(histogram, 50, maxMs),
	p95: percentile(histogram, 95, maxMs),
	p99: percentile(histogram, 99, maxMs),
});
