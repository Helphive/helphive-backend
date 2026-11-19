import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";
import RateLimitModel from "../dal/models/ratelimit.model";

const DUPLICATE_KEY = 11000;

/**
 * express-rate-limit store backed by the existing MongoDB, so a limit holds across all Cloud Run instances.
 * Each hit is one atomic upsert: a counter whose window has ended starts again at 1.
 */
export class MongoRateLimitStore implements Store {
	windowMs = 60 * 1000;
	localKeys = false;

	constructor(readonly prefix: string) {}

	init(options: Options) {
		this.windowMs = options.windowMs;
	}

	private id(key: string) {
		return `${this.prefix}:${key}`;
	}

	async get(key: string): Promise<ClientRateLimitInfo | undefined> {
		const doc = await RateLimitModel.collection.findOne({ _id: this.id(key) as any });
		if (!doc || doc.resetAt <= new Date()) return undefined;
		return { totalHits: doc.count, resetTime: doc.resetAt };
	}

	async increment(key: string): Promise<ClientRateLimitInfo> {
		const now = new Date();
		const freshReset = new Date(now.getTime() + this.windowMs);
		const expired = { $lte: [{ $ifNull: ["$resetAt", new Date(0)] }, now] };
		const update = [
			{
				$set: {
					count: { $cond: [expired, 1, { $add: ["$count", 1] }] },
					resetAt: { $cond: [expired, freshReset, "$resetAt"] },
				},
			},
			{ $set: { expireAt: "$resetAt" } },
		];
		for (let attempt = 0; ; attempt++) {
			try {
				const doc = await RateLimitModel.collection.findOneAndUpdate({ _id: this.id(key) as any }, update, {
					upsert: true,
					returnDocument: "after",
				});
				if (!doc) throw new Error("Rate limit counter was not returned.");
				return { totalHits: doc.count, resetTime: doc.resetAt };
			} catch (error: any) {
				// Two first hits racing on the same key: one upsert wins, the other retries as an update.
				if (error?.code === DUPLICATE_KEY && attempt === 0) continue;
				throw error;
			}
		}
	}

	async decrement(key: string) {
		await RateLimitModel.collection.updateOne(
			{ _id: this.id(key) as any, count: { $gt: 0 }, resetAt: { $gt: new Date() } },
			{ $inc: { count: -1 } },
		);
	}

	async resetKey(key: string) {
		await RateLimitModel.collection.deleteOne({ _id: this.id(key) as any });
	}
}
