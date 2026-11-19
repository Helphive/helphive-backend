// A lease so exactly one Cloud Run instance at a time runs the alert evaluator (and the periodic dependency checks).
// The holder renews it on every tick; if it stops (scaled in, crashed), another instance takes over once it expires.
// The store does the atomic compare-and-set; the decision and the clock are injectable for tests.

export interface LeaseState {
	holder: string;
	expiresAt: Date;
}

/** Whether `holder` may take or renew the lease now. */
export const canTakeLease = (current: LeaseState | null, holder: string, now: Date) =>
	!current || current.holder === holder || current.expiresAt.getTime() <= now.getTime();

export interface LeaseStore {
	/** Atomically sets the lease to `holder` until `expiresAt` if canTakeLease(current, holder, now). True if taken. */
	tryTake(name: string, holder: string, now: Date, expiresAt: Date): Promise<boolean>;
	/** Gives the lease up if `holder` still has it. */
	release(name: string, holder: string): Promise<void>;
}

export class Lease {
	constructor(
		private readonly store: LeaseStore,
		readonly name: string,
		readonly holder: string,
		private readonly ttlMs: number,
		private readonly clock: () => Date = () => new Date(),
	) {}

	/** Takes or renews the lease. False when another holder has an unexpired lease, or the store failed. */
	async acquire(): Promise<boolean> {
		const now = this.clock();
		try {
			return await this.store.tryTake(this.name, this.holder, now, new Date(now.getTime() + this.ttlMs));
		} catch {
			return false;
		}
	}

	async release(): Promise<void> {
		try {
			await this.store.release(this.name, this.holder);
		} catch {
			// Expiry frees it anyway.
		}
	}
}

/** In-memory store with the same semantics as the MongoDB one; used by tests. */
export class MemoryLeaseStore implements LeaseStore {
	readonly leases = new Map<string, LeaseState>();

	async tryTake(name: string, holder: string, now: Date, expiresAt: Date) {
		if (!canTakeLease(this.leases.get(name) ?? null, holder, now)) return false;
		this.leases.set(name, { holder, expiresAt });
		return true;
	}

	async release(name: string, holder: string) {
		if (this.leases.get(name)?.holder === holder) this.leases.delete(name);
	}
}
