import mongoose, { Schema, Types } from "mongoose";

// Operational records for the observability module: dependency checks, releases, alert rules, alerts and the
// evaluator lease. All small; history collections expire on `expireAt`.

export const DEPENDENCY_STATUSES = ["up", "degraded", "down", "unconfigured"] as const;
export type DependencyStatus = (typeof DEPENDENCY_STATUSES)[number];

export interface DependencyCheckDoc {
	_id: Types.ObjectId;
	at: Date;
	name: string;
	status: DependencyStatus;
	latencyMs: number | null;
	error: string | null;
	/** OBS_DEPENDENCY_RETENTION_DAYS after the check (default 30). */
	expireAt: Date;
}

const checkSchema = new Schema<DependencyCheckDoc>(
	{
		at: { type: Date, required: true },
		name: { type: String, required: true },
		status: { type: String, enum: DEPENDENCY_STATUSES, required: true },
		latencyMs: { type: Number, default: null },
		error: { type: String, default: null },
		expireAt: { type: Date, required: true },
	},
	{ versionKey: false, collection: "obsdependencychecks" },
);
checkSchema.index({ name: 1, at: -1 });
checkSchema.index({ at: -1 });
checkSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const DependencyCheckModel = mongoose.model<DependencyCheckDoc>("ObsDependencyCheck", checkSchema);

export interface ReleaseDoc {
	_id: Types.ObjectId;
	revision: string;
	service: string | null;
	commit: string | null;
	firstSeenAt: Date;
	lastSeenAt: Date;
}

const releaseSchema = new Schema<ReleaseDoc>(
	{
		revision: { type: String, required: true },
		service: { type: String, default: null },
		commit: { type: String, default: null },
		firstSeenAt: { type: Date, required: true },
		lastSeenAt: { type: Date, required: true },
	},
	{ versionKey: false, collection: "obsreleases" },
);
releaseSchema.index({ revision: 1 }, { unique: true });
releaseSchema.index({ firstSeenAt: -1 });

export const ReleaseModel = mongoose.model<ReleaseDoc>("ObsRelease", releaseSchema);

export interface AlertRuleDoc {
	_id: Types.ObjectId;
	key: string | null;
	name: string;
	kind: string;
	enabled: boolean;
	threshold: number;
	minutes: number;
	percentile: number | null;
	minRequests: number | null;
	route: string | null;
	dependency: string | null;
	newReleaseOnly: boolean | null;
	severity: "warning" | "critical";
	recipients: string[];
	cooldownMinutes: number;
	createdAt: Date;
	updatedAt: Date;
	createdBy: { id: string; email: string } | null;
	updatedBy: { id: string; email: string } | null;
	lastEvaluatedAt: Date | null;
	lastValue: number | null;
	lastSummary: string | null;
	deletedAt: Date | null;
}

const ruleSchema = new Schema<AlertRuleDoc>(
	{
		key: { type: String, default: null },
		name: { type: String, required: true },
		kind: { type: String, required: true },
		enabled: { type: Boolean, default: false },
		threshold: { type: Number, required: true },
		minutes: { type: Number, required: true },
		percentile: { type: Number, default: null },
		minRequests: { type: Number, default: null },
		route: { type: String, default: null },
		dependency: { type: String, default: null },
		newReleaseOnly: { type: Boolean, default: null },
		severity: { type: String, enum: ["warning", "critical"], default: "warning" },
		recipients: { type: [String], default: [] },
		cooldownMinutes: { type: Number, default: 30 },
		createdAt: { type: Date, required: true },
		updatedAt: { type: Date, required: true },
		createdBy: { type: Schema.Types.Mixed, default: null },
		updatedBy: { type: Schema.Types.Mixed, default: null },
		lastEvaluatedAt: { type: Date, default: null },
		lastValue: { type: Number, default: null },
		lastSummary: { type: String, default: null },
		deletedAt: { type: Date, default: null },
	},
	{ versionKey: false, collection: "obsalertrules" },
);
ruleSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $type: "string" } } });
ruleSchema.index({ deletedAt: 1, enabled: 1 });

export const AlertRuleModel = mongoose.model<AlertRuleDoc>("ObsAlertRule", ruleSchema);

export interface AlertDoc {
	_id: Types.ObjectId;
	ruleId: Types.ObjectId;
	ruleName: string;
	kind: string;
	severity: "warning" | "critical";
	status: "firing" | "acknowledged" | "resolved";
	firedAt: Date;
	acknowledgedAt: Date | null;
	acknowledgedBy: { id: string; email: string } | null;
	resolvedAt: Date | null;
	resolvedBy: { id: string; email: string } | null;
	value: number | null;
	threshold: number;
	summary: string;
	lastValue: number | null;
	notified: { at: Date; recipients: number; sent: number } | null;
	history: { at: Date; status: string; by: string | null; note: string | null }[];
	/** Set when resolved: OBS_ALERT_RETENTION_DAYS later (default 90). */
	expireAt: Date | null;
}

const alertSchema = new Schema<AlertDoc>(
	{
		ruleId: { type: Schema.Types.ObjectId, required: true },
		ruleName: { type: String, required: true },
		kind: { type: String, required: true },
		severity: { type: String, enum: ["warning", "critical"], default: "warning" },
		status: { type: String, enum: ["firing", "acknowledged", "resolved"], required: true },
		firedAt: { type: Date, required: true },
		acknowledgedAt: { type: Date, default: null },
		acknowledgedBy: { type: Schema.Types.Mixed, default: null },
		resolvedAt: { type: Date, default: null },
		resolvedBy: { type: Schema.Types.Mixed, default: null },
		value: { type: Number, default: null },
		threshold: { type: Number, required: true },
		summary: { type: String, default: "" },
		lastValue: { type: Number, default: null },
		notified: { type: Schema.Types.Mixed, default: null },
		history: { type: Schema.Types.Mixed, default: [] },
		expireAt: { type: Date, default: null },
	},
	{ versionKey: false, collection: "obsalerts" },
);
alertSchema.index({ status: 1, firedAt: -1 });
alertSchema.index({ ruleId: 1, firedAt: -1 });
alertSchema.index({ firedAt: -1 });
alertSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const AlertModel = mongoose.model<AlertDoc>("ObsAlert", alertSchema);

export interface LeaseDoc {
	_id: string;
	holder: string;
	expiresAt: Date;
}

const leaseSchema = new Schema<LeaseDoc>(
	{
		_id: { type: String, required: true },
		holder: { type: String, required: true },
		expiresAt: { type: Date, required: true },
	},
	{ versionKey: false, collection: "obsleases" },
);

export const LeaseModel = mongoose.model<LeaseDoc>("ObsLease", leaseSchema);
