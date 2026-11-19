import mongoose, { Schema, Types } from "mongoose";
import { RULE_ACTIONS, RULE_MODES, SEVERITIES } from "../../lib/risk/rules";
import { LIST_KINDS, LIST_TYPES } from "../../lib/risk/lists";

// Fraud and risk collections. Only admins read them (never part of a customer or provider response). Written by
// lib/risk/* and controllers/admin/risk.controller.ts.

const condition = new Schema(
	{
		signal: { type: String, required: true },
		op: { type: String, required: true },
		value: { type: Number, required: true },
	},
	{ _id: false },
);

/** riskrules: one per rule; the default pack is inserted at start (missing keys only, never overwritten). */
const riskRuleSchema = new Schema(
	{
		key: { type: String, required: true, unique: true },
		title: { type: String, required: true },
		explanation: { type: String, default: "" },
		match: { type: String, enum: ["all", "any"], default: "all" },
		conditions: { type: [condition], required: true },
		weight: { type: Number, required: true },
		severity: { type: String, enum: SEVERITIES, required: true },
		actions: { type: [String], enum: RULE_ACTIONS, default: ["score"] },
		mode: { type: String, enum: RULE_MODES, default: "observe" },
		isDefault: { type: Boolean, default: false },
		version: { type: Number, default: 1 },
		hits: { type: Number, default: 0 },
		lastFiredAt: { type: Date, default: null },
		createdBy: { id: Schema.Types.ObjectId, email: String },
		updatedBy: { id: Schema.Types.ObjectId, email: String },
		modeChangedAt: { type: Date, default: null },
	},
	{ timestamps: true, collection: "riskrules" },
);
export const RiskRuleModel = mongoose.model("RiskRule", riskRuleSchema);

/** riskscores: the latest explained score per person. */
const riskScoreSchema = new Schema(
	{
		userId: { type: Schema.Types.ObjectId, required: true, unique: true },
		score: { type: Number, required: true },
		band: { type: String, enum: SEVERITIES, required: true },
		contributions: { type: Schema.Types.Mixed, default: [] },
		signals: { type: Schema.Types.Mixed, default: {} },
		explanation: { type: String, default: "" },
		exempt: { type: String, default: null },
		evaluatedAt: { type: Date, required: true },
		trigger: { type: { type: String }, eventId: String },
	},
	{ collection: "riskscores", minimize: false },
);
riskScoreSchema.index({ score: -1 });
riskScoreSchema.index({ evaluatedAt: -1 });
export const RiskScoreModel = mongoose.model("RiskScore", riskScoreSchema);

/** riskhits: a rule firing for a person, at most one per rule, person and UTC day (unique key). */
const riskHitSchema = new Schema(
	{
		key: { type: String, required: true, unique: true },
		ruleKey: { type: String, required: true },
		userId: { type: Schema.Types.ObjectId, required: true },
		at: { type: Date, required: true },
		mode: { type: String, enum: RULE_MODES, required: true },
		severity: { type: String, enum: SEVERITIES, required: true },
		weight: Number,
		actionsTaken: { type: [String], default: [] },
		actionsWouldTake: { type: [String], default: [] },
		evidence: { type: Schema.Types.Mixed, default: [] },
		eventId: String,
	},
	{ collection: "riskhits", versionKey: false },
);
riskHitSchema.index({ at: -1 });
riskHitSchema.index({ ruleKey: 1, at: -1 });
riskHitSchema.index({ userId: 1, at: -1 });
export const RiskHitModel = mongoose.model("RiskHit", riskHitSchema);

export const CASE_SUBJECT_TYPES = ["user", "booking", "payment", "payout"] as const;
export type CaseSubjectType = (typeof CASE_SUBJECT_TYPES)[number];
export const CASE_STATUSES = ["open", "in_review", "cleared", "confirmed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** riskcases: a review case per subject. `active` is set only while open or in review (one active case per subject). */
const riskCaseSchema = new Schema(
	{
		subject: {
			type: { type: String, enum: CASE_SUBJECT_TYPES, required: true },
			id: { type: Schema.Types.ObjectId, required: true },
		},
		/** The person the case is about (the subject, or the customer/provider of a booking, payment or payout). */
		userId: { type: Schema.Types.ObjectId, default: null },
		title: { type: String, required: true },
		status: { type: String, enum: CASE_STATUSES, default: "open" },
		active: { type: Boolean, default: true },
		severity: { type: String, enum: SEVERITIES, required: true },
		score: { type: Number, default: 0 },
		rules: { type: [String], default: [] },
		evidence: { type: Schema.Types.Mixed, default: [] },
		linked: {
			userIds: { type: [String], default: [] },
			bookingIds: { type: [String], default: [] },
			paymentIds: { type: [String], default: [] },
			payoutIds: { type: [String], default: [] },
		},
		assignee: { id: Schema.Types.ObjectId, email: String },
		notes: {
			type: [{ body: String, author: { id: Schema.Types.ObjectId, email: String }, createdAt: Date }],
			default: [],
		},
		history: {
			type: [
				{
					_id: false,
					at: Date,
					action: String,
					by: { type: { type: String }, id: String, email: String },
					detail: Schema.Types.Mixed,
				},
			],
			default: [],
		},
		decision: {
			outcome: { type: String, enum: ["cleared", "confirmed"] },
			reason: String,
			by: { id: Schema.Types.ObjectId, email: String },
			at: Date,
		},
		openedBy: { type: { type: String, enum: ["rule", "admin"] }, ruleKey: String, adminId: Schema.Types.ObjectId },
		version: { type: Number, default: 0 },
	},
	{ timestamps: true, collection: "riskcases" },
);
riskCaseSchema.index(
	{ "subject.type": 1, "subject.id": 1 },
	{ unique: true, partialFilterExpression: { active: true }, name: "one_active_case_per_subject" },
);
riskCaseSchema.index({ status: 1, createdAt: -1 });
riskCaseSchema.index({ userId: 1, createdAt: -1 });
riskCaseSchema.index({ createdAt: -1 });
export const RiskCaseModel = mongoose.model("RiskCase", riskCaseSchema);

export const HOLD_KINDS = ["hold", "review_before_payout"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

/** riskholds: payout holds on providers. users.payoutHold mirrors the active ones for the atomic payout check. */
const riskHoldSchema = new Schema(
	{
		userId: { type: Schema.Types.ObjectId, required: true },
		kind: { type: String, enum: HOLD_KINDS, required: true },
		reason: { type: String, required: true },
		source: {
			type: { type: String, enum: ["rule", "admin", "case"], required: true },
			ruleKey: String,
			caseId: Schema.Types.ObjectId,
			adminId: Schema.Types.ObjectId,
			adminEmail: String,
		},
		active: { type: Boolean, default: true },
		releasedAt: { type: Date, default: null },
		releasedBy: { id: Schema.Types.ObjectId, email: String },
		releaseReason: { type: String, default: null },
		/** Payout requests and earning releases this hold stopped. */
		blocked: { payouts: { type: Number, default: 0 }, earnings: { type: Number, default: 0 } },
	},
	{ timestamps: true, collection: "riskholds" },
);
riskHoldSchema.index(
	{ userId: 1, kind: 1 },
	{ unique: true, partialFilterExpression: { active: true }, name: "one_active_hold_per_kind" },
);
riskHoldSchema.index({ active: 1, createdAt: -1 });
export const RiskHoldModel = mongoose.model("RiskHold", riskHoldSchema);

/** risklists: block and allow list entries; `value` is normalised (lib/risk/lists.ts). */
const riskListSchema = new Schema(
	{
		list: { type: String, enum: LIST_TYPES, required: true },
		kind: { type: String, enum: LIST_KINDS, required: true },
		value: { type: String, required: true },
		reason: { type: String, required: true },
		expiresAt: { type: Date, default: null },
		removedAt: { type: Date, default: null },
		createdBy: { id: Schema.Types.ObjectId, email: String },
		removedBy: { id: Schema.Types.ObjectId, email: String },
		caseId: { type: Schema.Types.ObjectId, default: null },
		/** Requests this entry refused (block) or let through (allow). */
		matches: { type: Number, default: 0 },
		lastMatchedAt: { type: Date, default: null },
	},
	{ timestamps: true, collection: "risklists" },
);
riskListSchema.index({ list: 1, kind: 1, value: 1 });
riskListSchema.index({ removedAt: 1, createdAt: -1 });
export const RiskListModel = mongoose.model("RiskList", riskListSchema);

/** riskcharges: Stripe's assessment of each charge, recorded from the payment webhooks. */
const riskChargeSchema = new Schema(
	{
		chargeId: { type: String, required: true, unique: true },
		paymentIntentId: String,
		paymentId: { type: Schema.Types.ObjectId, default: null },
		bookingId: { type: Schema.Types.ObjectId, default: null },
		userId: { type: Schema.Types.ObjectId, default: null },
		status: { type: String, enum: ["succeeded", "failed"], required: true },
		at: { type: Date, required: true },
		outcome: {
			type: { type: String },
			riskLevel: String,
			riskScore: Number,
			networkStatus: String,
			reason: String,
			sellerMessage: String,
		},
		card: { fingerprint: String, brand: String, last4: String, country: String, funding: String },
	},
	{ collection: "riskcharges", versionKey: false },
);
riskChargeSchema.index({ userId: 1, at: -1 });
riskChargeSchema.index({ paymentId: 1 });
riskChargeSchema.index({ at: -1 });
export const RiskChargeModel = mongoose.model("RiskCharge", riskChargeSchema);

/** riskobservations: the provider's last known position when a job started or completed. */
const riskObservationSchema = new Schema(
	{
		key: { type: String, required: true, unique: true },
		kind: { type: String, enum: ["start", "complete"], required: true },
		bookingId: { type: Schema.Types.ObjectId, required: true },
		providerId: { type: Schema.Types.ObjectId, required: true },
		at: { type: Date, required: true },
		distanceKm: { type: Number, required: true },
		fixAgeMs: { type: Number, required: true },
	},
	{ collection: "riskobservations", versionKey: false },
);
riskObservationSchema.index({ providerId: 1, at: -1 });
riskObservationSchema.index({ at: -1 });
export const RiskObservationModel = mongoose.model("RiskObservation", riskObservationSchema);

export type ObjectIdLike = Types.ObjectId | string;
