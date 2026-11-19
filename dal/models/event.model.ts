import mongoose, { Schema, Types } from "mongoose";

// Business event stream: what happened in the marketplace, for analytics and fraud detection. Written only through
// lib/events.ts (live) and scripts/backfill-events.ts (history). The catalogue of types and properties is
// EVENT_CATALOGUE in lib/eventCatalogue.ts.
//
// Subject ids are separate top-level fields so each can be indexed; a field is absent (not null) when it does not
// apply, which keeps the partial indexes small.
export interface EventDoc {
	_id: Types.ObjectId;
	type: string;
	at: Date;
	actor: { type: "user" | "provider" | "admin" | "system" | "anonymous"; id?: string };
	userId?: Types.ObjectId;
	providerId?: Types.ObjectId;
	bookingId?: Types.ObjectId;
	paymentId?: Types.ObjectId;
	payoutId?: Types.ObjectId;
	applicationId?: Types.ObjectId;
	earningId?: Types.ObjectId;
	properties: Record<string, unknown>;
	context: {
		ip?: string;
		userAgent?: string;
		platform?: string;
		appVersion?: string;
		deviceId?: string;
		requestId?: string;
	};
	source: "live" | "backfill";
	/** Deterministic id for derived or replayable events; unique, so writing the same one twice is a no-op. */
	key?: string;
	v: number;
}

const objectId = { type: Schema.Types.ObjectId, required: false };

const eventSchema = new Schema<EventDoc>(
	{
		type: { type: String, required: true },
		at: { type: Date, required: true },
		actor: {
			type: { type: String, enum: ["user", "provider", "admin", "system", "anonymous"], required: true },
			id: { type: String },
		},
		userId: objectId,
		providerId: objectId,
		bookingId: objectId,
		paymentId: objectId,
		payoutId: objectId,
		applicationId: objectId,
		earningId: objectId,
		properties: { type: Schema.Types.Mixed, default: {} },
		context: {
			ip: String,
			userAgent: String,
			platform: String,
			appVersion: String,
			deviceId: String,
			requestId: String,
		},
		source: { type: String, enum: ["live", "backfill"], required: true, default: "live" },
		key: { type: String },
		v: { type: Number, default: 1 },
	},
	{ versionKey: false, collection: "events", minimize: false },
);

eventSchema.index({ type: 1, at: -1 });
eventSchema.index({ at: -1 });
for (const field of ["userId", "providerId", "bookingId", "paymentId", "payoutId", "applicationId", "earningId"]) {
	eventSchema.index({ [field]: 1, at: -1 }, { partialFilterExpression: { [field]: { $exists: true } } });
}
eventSchema.index({ "actor.id": 1, at: -1 }, { partialFilterExpression: { "actor.id": { $exists: true } } });
// Fraud work: everything from one address or one device.
eventSchema.index({ "context.ip": 1, at: -1 }, { partialFilterExpression: { "context.ip": { $exists: true } } });
eventSchema.index(
	{ "context.deviceId": 1, at: -1 },
	{ partialFilterExpression: { "context.deviceId": { $exists: true } } },
);
eventSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $exists: true } } });

const EventModel = mongoose.model<EventDoc>("Event", eventSchema);

export default EventModel;
