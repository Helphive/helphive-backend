import mongoose, { Schema, Types } from "mongoose";

// One document per webhook event received (Stripe today), with what came of it. The payload is not stored: Stripe
// keeps every event for 30 days, so a replay fetches it again by id (stripe.events.retrieve, with the connected
// account for connected events), which also re-verifies it came from Stripe.
export const WEBHOOK_OUTCOMES = ["received", "processed", "ignored", "failed"] as const;
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];

export interface WebhookEventDoc {
	_id: Types.ObjectId;
	provider: "stripe";
	endpoint: string;
	eventId: string;
	type: string;
	account?: string | null;
	/** The id of the event's object (payment intent, refund, payout); recorded from now on, absent on older events. */
	objectId?: string | null;
	livemode?: boolean;
	receivedAt: Date;
	processedAt?: Date | null;
	outcome: WebhookOutcome;
	note?: string | null;
	error?: string | null;
	deliveries: number;
	lastDeliveryAt: Date;
	requestId?: string | null;
}

const webhookEventSchema = new Schema<WebhookEventDoc>(
	{
		provider: { type: String, enum: ["stripe"], required: true },
		endpoint: { type: String, required: true },
		eventId: { type: String, required: true },
		type: { type: String, required: true },
		account: { type: String, default: null },
		objectId: { type: String, default: null },
		livemode: { type: Boolean },
		receivedAt: { type: Date, required: true },
		processedAt: { type: Date, default: null },
		outcome: { type: String, enum: WEBHOOK_OUTCOMES, required: true },
		note: { type: String, default: null },
		error: { type: String, default: null },
		deliveries: { type: Number, default: 1 },
		lastDeliveryAt: { type: Date, required: true },
		requestId: { type: String, default: null },
	},
	{ versionKey: false, collection: "webhookevents" },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ receivedAt: -1 });
webhookEventSchema.index({ type: 1, receivedAt: -1 });
webhookEventSchema.index({ outcome: 1, receivedAt: -1 });
// The events about one payment intent, refund or payout (payment and payout detail pages).
webhookEventSchema.index({ objectId: 1, receivedAt: -1 });

const WebhookEventModel = mongoose.model<WebhookEventDoc>("WebhookEvent", webhookEventSchema);

export default WebhookEventModel;
