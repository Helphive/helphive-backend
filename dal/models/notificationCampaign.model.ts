import mongoose, { Schema, Types } from "mongoose";

// One document per announcement send (lib/notifications.ts): who, what, to which segment, and what came of it. The
// idempotency key is unique, so a repeated send returns this record instead of sending again.
export interface NotificationCampaignDoc {
	_id: Types.ObjectId;
	idempotencyKey: string;
	fingerprint: string;
	status: "sending" | "sent" | "partial" | "failed";
	segment: Record<string, unknown>;
	channels: string[];
	template: { title: string; body: string; emailSubject?: string | null };
	templateId?: Types.ObjectId | null;
	by: { id: Types.ObjectId; email: string };
	audience: Record<string, unknown>;
	results: Record<string, unknown>;
	startedAt: Date;
	finishedAt?: Date | null;
	error?: string | null;
	createdAt: Date;
}

const campaignSchema = new Schema<NotificationCampaignDoc>(
	{
		idempotencyKey: { type: String, required: true, unique: true },
		fingerprint: { type: String, required: true },
		status: { type: String, enum: ["sending", "sent", "partial", "failed"], required: true },
		segment: { type: Schema.Types.Mixed, required: true },
		channels: { type: [String], required: true },
		template: { title: String, body: String, emailSubject: { type: String, default: null } },
		templateId: { type: Schema.Types.ObjectId, default: null },
		by: { id: { type: Schema.Types.ObjectId, ref: "Admin" }, email: String },
		audience: { type: Schema.Types.Mixed, default: {} },
		results: { type: Schema.Types.Mixed, default: {} },
		startedAt: { type: Date, required: true },
		finishedAt: { type: Date, default: null },
		error: { type: String, default: null },
	},
	{ timestamps: true, collection: "notificationcampaigns", minimize: false },
);

campaignSchema.index({ startedAt: -1 });

export const NotificationCampaignModel = mongoose.model<NotificationCampaignDoc>(
	"NotificationCampaign",
	campaignSchema,
);

// Reusable announcement texts with placeholders.
export interface NotificationTemplateDoc {
	_id: Types.ObjectId;
	name: string;
	title: string;
	body: string;
	emailSubject?: string | null;
	updatedBy: { id: Types.ObjectId; email: string };
	deletedAt?: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

const templateSchema = new Schema<NotificationTemplateDoc>(
	{
		name: { type: String, required: true, maxlength: 80 },
		title: { type: String, required: true },
		body: { type: String, required: true },
		emailSubject: { type: String, default: null },
		updatedBy: { id: { type: Schema.Types.ObjectId, ref: "Admin" }, email: String },
		deletedAt: { type: Date, default: null },
	},
	{ timestamps: true, collection: "notificationtemplates" },
);

templateSchema.index({ deletedAt: 1, name: 1 });

export const NotificationTemplateModel = mongoose.model<NotificationTemplateDoc>(
	"NotificationTemplate",
	templateSchema,
);
