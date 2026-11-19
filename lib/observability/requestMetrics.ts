// Request metrics: an in-process aggregator that counts every finished request by minute, route pattern, method and
// status class with a latency histogram, flushed every 20 seconds as $inc upserts (so instances merge safely).
// Recording is a Map update; nothing touches the database on the request path, and nothing here can throw into it.
import { addToHistogram, type Histogram } from "./histogram";

export interface RequestSample {
	route: string;
	method: string;
	status: number;
	latencyMs: number;
	revision: string;
}

export interface MetricCell {
	m: number;
	r: string;
	mt: string;
	rv: string;
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

export const MINUTE_MS = 60_000;
export const OVERFLOW_ROUTE = "(overflow)";

export class RequestMetricsAggregator {
	private cells = new Map<string, MetricCell>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly maxCells = 5000,
	) {}

	get size() {
		return this.cells.size;
	}

	record(sample: RequestSample) {
		const m = Math.floor(this.now() / MINUTE_MS) * MINUTE_MS;
		let route = sample.route.slice(0, 200);
		const method = sample.method.slice(0, 10).toUpperCase();
		let key = `${m}|${method}|${route}|${sample.revision}`;
		let cell = this.cells.get(key);
		if (!cell && this.cells.size >= this.maxCells) {
			route = OVERFLOW_ROUTE;
			key = `${m}|${method}|${route}|${sample.revision}`;
			cell = this.cells.get(key);
		}
		if (!cell) {
			cell = {
				m,
				r: route,
				mt: method,
				rv: sample.revision,
				n: 0,
				s2: 0,
				s3: 0,
				s4: 0,
				s5: 0,
				rl: 0,
				sum: 0,
				max: 0,
				h: {},
			};
			this.cells.set(key, cell);
		}
		const latency = Number.isFinite(sample.latencyMs) && sample.latencyMs > 0 ? sample.latencyMs : 0;
		cell.n++;
		const status = sample.status;
		if (status >= 500) cell.s5++;
		else if (status >= 400) cell.s4++;
		else if (status >= 300) cell.s3++;
		else cell.s2++;
		if (status === 429) cell.rl++;
		cell.sum += latency;
		if (latency > cell.max) cell.max = latency;
		addToHistogram(cell.h, latency);
	}

	/** Takes everything recorded so far. */
	drain(): MetricCell[] {
		const cells = [...this.cells.values()];
		this.cells.clear();
		return cells;
	}

	/** Puts cells back after a failed write (merging with anything recorded meanwhile), within the cap. */
	restore(cells: MetricCell[]) {
		for (const cell of cells) {
			const key = `${cell.m}|${cell.mt}|${cell.r}|${cell.rv}`;
			const current = this.cells.get(key);
			if (!current) {
				if (this.cells.size < this.maxCells) this.cells.set(key, cell);
				continue;
			}
			for (const field of ["n", "s2", "s3", "s4", "s5", "rl", "sum"] as const) current[field] += cell[field];
			current.max = Math.max(current.max, cell.max);
			for (const [bucket, count] of Object.entries(cell.h)) current.h[bucket] = (current.h[bucket] ?? 0) + count;
		}
	}
}

/** The upsert for one cell: counters added, maximum kept, histogram buckets added. */
export const metricUpsert = (cell: MetricCell, retentionMs: number) => {
	const inc: Record<string, number> = {
		n: cell.n,
		s2: cell.s2,
		s3: cell.s3,
		s4: cell.s4,
		s5: cell.s5,
		rl: cell.rl,
		sum: Math.round(cell.sum * 10) / 10,
	};
	for (const [bucket, count] of Object.entries(cell.h)) inc[`h.${bucket}`] = count;
	return {
		updateOne: {
			filter: { m: new Date(cell.m), r: cell.r, mt: cell.mt, rv: cell.rv },
			update: {
				$inc: inc,
				$max: { max: Math.round(cell.max * 10) / 10 },
				$setOnInsert: { expireAt: new Date(cell.m + retentionMs) },
			},
			upsert: true,
		},
	};
};
