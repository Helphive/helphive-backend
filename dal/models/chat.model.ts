// Chat records kept by this server. Message bodies live in CometChat; the only copy here is the reported message in a
// report, deleted with the report after CHAT_RETENTION_DAYS.
import mongoose, { Schema, Types } from "mongoose";
import { REPORT_CATEGORIES } from "../../lib/chat/chatRules";

/**
 * One per customer-provider pair that has ever shared an accepted booking (or the demo pair): whether they may chat
 * now (mirrored to CometChat as a friendship) and until when. Kept after the window closes, as the record that they
 * were counterparties (blocks and reports are allowed between them).
 */
export interface ChatLinkDoc {
	_id: Types.ObjectId;
	customerId: Types.ObjectId;
	providerId: Types.ObjectId;
	allowed: boolean;
	/** When it stops being allowed if nothing changes; null while a booking is active, or when not allowed. */
	until: Date | null;
	bookingIds: Types.ObjectId[];
	demo: boolean;
	/** Whether CometChat matched `allowed` at the last sync, and the error code when it did not. */
	synced: boolean;
	syncError?: string | null;
	syncedAt: Date;
	openedAt?: Date | null;
	closedAt?: Date | null;
}

const chatLinkSchema = new Schema<ChatLinkDoc>(
	{
		customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
		providerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
		allowed: { type: Boolean, required: true },
		until: { type: Date, default: null },
		bookingIds: { type: [Schema.Types.ObjectId], default: [] },
		demo: { type: Boolean, default: false },
		synced: { type: Boolean, default: false },
		syncError: { type: String, default: null },
		syncedAt: { type: Date, required: true },
		openedAt: { type: Date, default: null },
		closedAt: { type: Date, default: null },
	},
	{ versionKey: false, collection: "chatlinks" },
);
chatLinkSchema.index({ customerId: 1, providerId: 1 }, { unique: true });
chatLinkSchema.index({ providerId: 1, allowed: 1 });
chatLinkSchema.index({ customerId: 1, allowed: 1 });
// Windows that have passed and still need closing (lazy sweep and the reconciliation script).
chatLinkSchema.index({ allowed: 1, until: 1 });
chatLinkSchema.index({ synced: 1, syncedAt: 1 });

export const ChatLinkModel = mongoose.model<ChatLinkDoc>("ChatLink", chatLinkSchema);

/** A person blocked a counterparty (from the HelpHive API or inside the chat UI, learnt from the webhook). */
export interface ChatBlockDoc {
	_id: Types.ObjectId;
	blockerId: Types.ObjectId;
	blockedId: Types.ObjectId;
	source: "api" | "chat";
	createdAt: Date;
}

const chatBlockSchema = new Schema<ChatBlockDoc>(
	{
		blockerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
		blockedId: { type: Schema.Types.ObjectId, ref: "User", required: true },
		source: { type: String, enum: ["api", "chat"], required: true },
		createdAt: { type: Date, required: true },
	},
	{ versionKey: false, collection: "chatblocks" },
);
chatBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
chatBlockSchema.index({ blockedId: 1 });

export const ChatBlockModel = mongoose.model<ChatBlockDoc>("ChatBlock", chatBlockSchema);

export const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface ChatReportDoc {
	_id: Types.ObjectId;
	reporterId: Types.ObjectId;
	reportedUserId: Types.ObjectId;
	category: (typeof REPORT_CATEGORIES)[number];
	details?: string | null;
	messageId?: string | null;
	/** Copy of the reported message as it was when reported (the only message text this server keeps). */
	message?: {
		id: string;
		type: string;
		sentAt: Date | null;
		body: string | null;
		attachmentTypes: string[];
	} | null;
	status: ReportStatus;
	createdAt: Date;
	resolvedAt?: Date | null;
	resolvedBy?: Types.ObjectId | null;
	resolution?: string | null;
	/** Deleted (TTL) after CHAT_RETENTION_DAYS. */
	purgeAt: Date;
}

const chatReportSchema = new Schema<ChatReportDoc>(
	{
		reporterId: { type: Schema.Types.ObjectId, ref: "User", required: true },
		reportedUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
		category: { type: String, enum: REPORT_CATEGORIES, required: true },
		details: { type: String, default: null, maxlength: 1000 },
		messageId: { type: String, default: null },
		message: {
			type: new Schema(
				{
					id: { type: String, required: true },
					type: { type: String },
					sentAt: { type: Date, default: null },
					body: { type: String, default: null, maxlength: 5000 },
					attachmentTypes: { type: [String], default: [] },
				},
				{ _id: false },
			),
			default: null,
		},
		status: { type: String, enum: REPORT_STATUSES, default: "open" },
		createdAt: { type: Date, required: true },
		resolvedAt: { type: Date, default: null },
		resolvedBy: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
		resolution: { type: String, default: null, maxlength: 1000 },
		purgeAt: { type: Date, required: true },
	},
	{ versionKey: false, collection: "chatreports" },
);
chatReportSchema.index({ status: 1, createdAt: -1 });
chatReportSchema.index({ createdAt: -1 });
chatReportSchema.index({ reportedUserId: 1, createdAt: -1 });
chatReportSchema.index({ reporterId: 1, messageId: 1 });
chatReportSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const ChatReportModel = mongoose.model<ChatReportDoc>("ChatReport", chatReportSchema);
