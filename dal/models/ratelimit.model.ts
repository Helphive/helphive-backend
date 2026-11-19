import mongoose, { Schema } from "mongoose";

// One counter per rate-limit key, shared by every Cloud Run instance. MongoDB's TTL monitor deletes a counter once its
// window has ended (it runs about once a minute, so expired documents may linger briefly; reads ignore them).
export interface RateLimitCounter {
	_id: string;
	count: number;
	resetAt: Date;
	expireAt: Date;
}

const rateLimitSchema = new Schema<RateLimitCounter>(
	{
		_id: { type: String, required: true },
		count: { type: Number, required: true },
		resetAt: { type: Date, required: true },
		expireAt: { type: Date, required: true, expires: 0 },
	},
	{ versionKey: false, collection: "ratelimits" },
);

const RateLimitModel = mongoose.model<RateLimitCounter>("RateLimit", rateLimitSchema);

export default RateLimitModel;
