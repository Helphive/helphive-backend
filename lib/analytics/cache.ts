// A short-lived in-memory cache for analytics answers, per server instance. Keyed by the normalised query (so
// equivalent URLs share an entry); concurrent misses for one key share a single computation. Bounded in size: the
// oldest entry goes first.
export class TtlCache<T> {
	private entries = new Map<string, { at: number; value: Promise<T> }>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxEntries: number,
		private readonly now: () => number = Date.now,
	) {}

	get size() {
		return this.entries.size;
	}

	/** The cached value for `key`, or `compute()` stored for ttlMs. A failed computation is not kept. */
	get(key: string, compute: () => Promise<T>): Promise<T> {
		const hit = this.entries.get(key);
		const t = this.now();
		if (hit && t - hit.at < this.ttlMs) return hit.value;
		if (hit) this.entries.delete(key);
		const value = compute();
		this.entries.set(key, { at: t, value });
		value.catch(() => {
			if (this.entries.get(key)?.value === value) this.entries.delete(key);
		});
		while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
		return value;
	}

	clear() {
		this.entries.clear();
	}
}
