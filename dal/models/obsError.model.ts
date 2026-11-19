import mongoose, { Schema, Types } from "mongoose";

// Error tracking (lib/observability/errorTracker.ts): groups by fingerprint, sampled occurrences, and hourly counts
// for trends. Messages and stacks are scrubbed before they are stored (lib/observability/scrub.ts).

export const ERROR_STATUSES = ["unresolved", "resolved", "ignored"] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];
export const ERROR_SOURCES = ["server", "client"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export interface ErrorGroupDoc {
	_id: Types.ObjectId;
	fingerprint: string;
	source: ErrorSource;
	/** Client errors: web, ios, android, admin. Server: "server". */
	platform: string;
	type: string;
	title: string;
	message: string;
	culprit: string | null;
	route: string | null;
	status: ErrorStatus;
	count: number;
	/** Distinct signed-in users and admins seen (first 200 kept). */
	users: string[];
	userCount: number;
	firstSeenAt: Date;
	lastSeenAt: Date;
	firstRevision: string | null;
	lastRevision: string | null;
	/** Client errors: app versions seen (first 50). */
	appVersions: string[];
	lastAppVersion: string | null;
	statusChangedAt: Date | null;
	statusChangedBy: { id: string; email: string } | null;
	resolvedInRevision: string | null;
	resolvedRevisionNumber: number | null;
	reopenedAt: Date | null;
	reopenCount: number;
	/** Removed this long after the last occurrence (OBS_ERROR_GROUP_RETENTION_DAYS, default 90). */
	expireAt: Date;
}

const groupSchema = new Schema<ErrorGroupDoc>(
	{
		fingerprint: { type: String, required: true },
		source: { type: String, enum: ERROR_SOURCES, required: true },
		platform: { type: String, required: true },
		type: { type: String, default: "Error" },
		title: { type: String, required: true },
		message: { type: String, default: "" },
		culprit: { type: String, default: null },
		route: { type: String, default: null },
		status: { type: String, enum: ERROR_STATUSES, default: "unresolved" },
		count: { type: Number, default: 0 },
		users: { type: [String], default: [] },
		userCount: { type: Number, default: 0 },
		firstSeenAt: { type: Date, required: true },
		lastSeenAt: { type: Date, required: true },
		firstRevision: { type: String, default: null },
		lastRevision: { type: String, default: null },
		appVersions: { type: [String], default: [] },
		lastAppVersion: { type: String, default: null },
		statusChangedAt: { type: Date, default: null },
		statusChangedBy: { type: Schema.Types.Mixed, default: null },
		resolvedInRevision: { type: String, default: null },
		resolvedRevisionNumber: { type: Number, default: null },
		reopenedAt: { type: Date, default: null },
		reopenCount: { type: Number, default: 0 },
		expireAt: { type: Date, required: true },
	},
	{ versionKey: false, collection: "obserrorgroups" },
);

groupSchema.index({ fingerprint: 1 }, { unique: true });
groupSchema.index({ status: 1, lastSeenAt: -1 });
groupSchema.index({ source: 1, platform: 1, lastSeenAt: -1 });
groupSchema.index({ lastSeenAt: -1 });
groupSchema.index({ firstSeenAt: -1 });
groupSchema.index({ firstRevision: 1, firstSeenAt: -1 });
groupSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const ErrorGroupModel = mongoose.model<ErrorGroupDoc>("ObsErrorGroup", groupSchema);

export interface ErrorOccurrenceDoc {
	_id: Types.ObjectId;
	fingerprint: string;
	at: Date;
	source: ErrorSource;
	message: string;
	stack: string | null;
	route: string | null;
	method: string | null;
	status: number | null;
	requestId: string | null;
	trace: string | null;
	userId: string | null;
	adminId: string | null;
	platform: string | null;
	appVersion: string | null;
	deviceId: string | null;
	revision: string | null;
	/** Client errors: browser or OS details the reporter sent (scrubbed). */
	userAgent: string | null;
	/** Removed this long after it happened (OBS_ERROR_OCCURRENCE_RETENTION_DAYS, default 14). */
	expireAt: Date;
}

const occurrenceSchema = new Schema<ErrorOccurrenceDoc>(
	{
		fingerprint: { type: String, required: true },
		at: { type: Date, required: true },
		source: { type: String, enum: ERROR_SOURCES, required: true },
		message: { type: String, default: "" },
		stack: { type: String, default: null },
		route: { type: String, default: null },
		method: { type: String, default: null },
		status: { type: Number, default: null },
		requestId: { type: String, default: null },
		trace: { type: String, default: null },
		userId: { type: String, default: null },
		adminId: { type: String, default: null },
		platform: { type: String, default: null },
		appVersion: { type: String, default: null },
		deviceId: { type: String, default: null },
		revision: { type: String, default: null },
		userAgent: { type: String, default: null },
		expireAt: { type: Date, required: true },
	},
	{ versionKey: false, collection: "obserroroccurrences" },
);

occurrenceSchema.index({ fingerprint: 1, at: -1 });
occurrenceSchema.index({ requestId: 1 }, { partialFilterExpression: { requestId: { $type: "string" } } });
occurrenceSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const ErrorOccurrenceModel = mongoose.model<ErrorOccurrenceDoc>("ObsErrorOccurrence", occurrenceSchema);

/** Exact counts per group per hour (occurrences are sampled), for trends. Kept as long as request metrics. */
export interface ErrorCountDoc {
	fingerprint: string;
	hour: Date;
	n: number;
	expireAt: Date;
}

const countSchema = new Schema<ErrorCountDoc>(
	{
		fingerprint: { type: String, required: true },
		hour: { type: Date, required: true },
		n: { type: Number, default: 0 },
		expireAt: { type: Date, required: true },
	},
	{ versionKey: false, collection: "obserrorcounts" },
);

countSchema.index({ fingerprint: 1, hour: 1 }, { unique: true });
countSchema.index({ hour: 1 });
countSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const ErrorCountModel = mongoose.model<ErrorCountDoc>("ObsErrorCount", countSchema);
