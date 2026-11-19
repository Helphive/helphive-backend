import mongoose, { Schema, Types } from "mongoose";

// Append-only record of admin actions and admin sign-ins. Written only through lib/audit.ts. Every update and delete
// path Mongoose offers is refused below, and tests/audit.test.ts checks that no code calls one.
export interface AuditLogDoc {
	_id: Types.ObjectId;
	at: Date;
	action: string;
	outcome: "success" | "failure";
	actor: { type: "admin" | "anonymous" | "system"; id?: Types.ObjectId | null; email?: string | null };
	target?: { type: string; id?: string | null } | null;
	summary?: { before?: unknown; after?: unknown } | null;
	reason?: string | null;
	metadata?: Record<string, unknown> | null;
	ip?: string | null;
	userAgent?: string | null;
	requestId?: string | null;
}

const auditLogSchema = new Schema<AuditLogDoc>(
	{
		at: { type: Date, required: true, default: Date.now, immutable: true },
		action: { type: String, required: true, immutable: true },
		outcome: { type: String, enum: ["success", "failure"], required: true, immutable: true },
		actor: {
			type: { type: String, enum: ["admin", "anonymous", "system"], required: true },
			id: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
			email: { type: String, default: null },
		},
		target: {
			type: { type: String },
			id: { type: String, default: null },
		},
		summary: { type: Schema.Types.Mixed, default: null },
		reason: { type: String, default: null },
		metadata: { type: Schema.Types.Mixed, default: null },
		ip: { type: String, default: null },
		userAgent: { type: String, default: null },
		requestId: { type: String, default: null },
	},
	{ versionKey: false, collection: "auditlogs" },
);

auditLogSchema.index({ at: -1 });
auditLogSchema.index({ "actor.id": 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });
auditLogSchema.index({ "target.type": 1, "target.id": 1, at: -1 });

export class AuditLogImmutableError extends Error {
	constructor() {
		super("Audit log entries cannot be changed or deleted.");
	}
}

const refuse = function (next: (error?: Error) => void) {
	next(new AuditLogImmutableError());
};

const MUTATING_QUERIES = [
	"updateOne",
	"updateMany",
	"findOneAndUpdate",
	"replaceOne",
	"findOneAndReplace",
	"deleteOne",
	"deleteMany",
	"findOneAndDelete",
] as const;
for (const op of MUTATING_QUERIES) auditLogSchema.pre(op as any, { query: true, document: false }, refuse as any);
auditLogSchema.pre("deleteOne", { document: true, query: false }, refuse as any);
// "validate" runs before "save"; both refuse a document that already exists.
for (const hook of ["validate", "save"] as const) {
	auditLogSchema.pre(hook, function (next) {
		if (!this.isNew) return next(new AuditLogImmutableError());
		next();
	});
}
auditLogSchema.pre("bulkWrite" as any, refuse as any);
auditLogSchema.pre("insertMany", function (next: (error?: Error) => void) {
	next(new AuditLogImmutableError());
});

const AuditLogModel = mongoose.model<AuditLogDoc>("AuditLog", auditLogSchema);

export default AuditLogModel;
