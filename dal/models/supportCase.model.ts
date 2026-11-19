import mongoose, { Schema, Types } from "mongoose";
import {
	CASE_ACTION_TYPES,
	CASE_CATEGORIES,
	CASE_OUTCOMES,
	CASE_PRIORITIES,
	CASE_SOURCES,
	CASE_STATUSES,
} from "../../lib/supportCases";

// A support case about a booking, a payment or a person (lib/supportCases.ts). Internal notes never reach customers or
// providers; messages are the emails sent to them from the case. `source`/`openedBy` allow app-opened cases later.
const adminRef = { id: { type: Schema.Types.ObjectId, ref: "Admin" }, email: { type: String } };

export interface SupportCaseDoc {
	_id: Types.ObjectId;
	reference: string;
	category: string;
	subject: string;
	description: string;
	source: string;
	openedBy: { actorType: "admin" | "user"; id: Types.ObjectId; email?: string };
	status: string;
	priority: string;
	assignee?: { id: Types.ObjectId; email: string } | null;
	bookingId?: Types.ObjectId | null;
	paymentId?: Types.ObjectId | null;
	userId?: Types.ObjectId | null;
	parties: { role: "customer" | "provider"; userId: Types.ObjectId }[];
	notes: { _id: Types.ObjectId; body: string; author: { id: Types.ObjectId; email: string }; at: Date }[];
	messages: {
		_id: Types.ObjectId;
		to: "customer" | "provider";
		userId: Types.ObjectId;
		subject: string;
		body: string;
		channel: "email";
		result: "sent" | "skipped" | "failed";
		skippedBecause?: string | null;
		messageId?: string | null;
		idempotencyKey: string;
		by: { id: Types.ObjectId; email: string };
		at: Date;
	}[];
	actions: {
		_id: Types.ObjectId;
		kind: string;
		targetType: string;
		targetId: string;
		summary: string;
		by: { id: Types.ObjectId; email: string };
		at: Date;
	}[];
	resolution?: { outcome: string; summary: string; at: Date; by: { id: Types.ObjectId; email: string } } | null;
	lastActivityAt: Date;
	version: number;
	createdAt: Date;
	updatedAt: Date;
}

const supportCaseSchema = new Schema<SupportCaseDoc>(
	{
		reference: { type: String, required: true },
		category: { type: String, enum: CASE_CATEGORIES, required: true },
		subject: { type: String, required: true, maxlength: 200 },
		description: { type: String, required: true, maxlength: 5000 },
		source: { type: String, enum: CASE_SOURCES, default: "admin" },
		openedBy: {
			actorType: { type: String, enum: ["admin", "user"], required: true },
			id: { type: Schema.Types.ObjectId, required: true },
			email: { type: String },
		},
		status: { type: String, enum: CASE_STATUSES, default: "open" },
		priority: { type: String, enum: CASE_PRIORITIES, default: "normal" },
		assignee: { type: adminRef, default: null },
		bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
		paymentId: { type: Schema.Types.ObjectId, ref: "Payment", default: null },
		userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
		parties: {
			type: [
				{ role: { type: String, enum: ["customer", "provider"] }, userId: Schema.Types.ObjectId, _id: false },
			],
			default: [],
		},
		notes: {
			type: [{ body: { type: String, maxlength: 5000 }, author: adminRef, at: Date }],
			default: [],
		},
		messages: {
			type: [
				{
					to: { type: String, enum: ["customer", "provider"] },
					userId: Schema.Types.ObjectId,
					subject: String,
					body: String,
					channel: { type: String, default: "email" },
					result: { type: String, enum: ["sent", "skipped", "failed"] },
					skippedBecause: { type: String, default: null },
					messageId: { type: String, default: null },
					idempotencyKey: String,
					by: adminRef,
					at: Date,
				},
			],
			default: [],
		},
		actions: {
			type: [
				{
					kind: { type: String, enum: CASE_ACTION_TYPES },
					targetType: String,
					targetId: String,
					summary: { type: String, maxlength: 1000 },
					by: adminRef,
					at: Date,
				},
			],
			default: [],
		},
		resolution: {
			type: new Schema(
				{ outcome: { type: String, enum: CASE_OUTCOMES }, summary: String, at: Date, by: adminRef },
				{ _id: false },
			),
			default: null,
		},
		lastActivityAt: { type: Date, default: Date.now },
		version: { type: Number, default: 0 },
	},
	{ timestamps: true, collection: "supportcases" },
);

supportCaseSchema.index({ status: 1, priority: 1, lastActivityAt: -1 });
supportCaseSchema.index({ "assignee.id": 1, status: 1 });
supportCaseSchema.index({ bookingId: 1 });
supportCaseSchema.index({ paymentId: 1 });
supportCaseSchema.index({ "parties.userId": 1 });
supportCaseSchema.index({ createdAt: -1 });
supportCaseSchema.index({ reference: 1 });

const SupportCaseModel = mongoose.model<SupportCaseDoc>("SupportCase", supportCaseSchema);

export default SupportCaseModel;
