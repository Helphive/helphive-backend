import mongoose, { Schema, Types } from "mongoose";

// One document per admin sign-in (a refresh-token "family"). The refresh token itself is never stored, only the hash
// of the current one and of the one before it (see lib/adminRefreshTokens.ts). MongoDB's TTL monitor deletes a session
// a week after it expires; revoked sessions stay until then so the admin can see them.
export interface AdminSessionDoc {
	_id: Types.ObjectId;
	adminId: Types.ObjectId;
	generation: number;
	tokenHash: string;
	previousTokenHash?: string | null;
	rotatedAt?: Date | null;
	createdAt: Date;
	lastUsedAt: Date;
	expiresAt: Date;
	deleteAt: Date;
	revokedAt?: Date | null;
	revokedReason?: string | null;
	ip?: string;
	userAgent?: string;
	lastIp?: string;
	lastUserAgent?: string;
	mfa: boolean;
}

export const ADMIN_SESSION_REVOKE_REASONS = [
	"logout",
	"logout_all",
	"revoked_by_admin",
	"revoked_by_self",
	"reuse_detected",
	"password_changed",
	"admin_disabled",
	"forced_sign_out",
	"mfa_reset",
] as const;

const adminSessionSchema = new Schema<AdminSessionDoc>(
	{
		adminId: { type: Schema.Types.ObjectId, ref: "Admin", required: true },
		generation: { type: Number, required: true, default: 0 },
		tokenHash: { type: String, required: true },
		previousTokenHash: { type: String, default: null },
		rotatedAt: { type: Date, default: null },
		createdAt: { type: Date, required: true, default: Date.now },
		lastUsedAt: { type: Date, required: true, default: Date.now },
		expiresAt: { type: Date, required: true },
		deleteAt: { type: Date, required: true, expires: 0 },
		revokedAt: { type: Date, default: null },
		revokedReason: { type: String, enum: [...ADMIN_SESSION_REVOKE_REASONS, null], default: null },
		ip: { type: String },
		userAgent: { type: String },
		lastIp: { type: String },
		lastUserAgent: { type: String },
		// Whether this sign-in passed two-step verification.
		mfa: { type: Boolean, default: false },
	},
	{ versionKey: false, collection: "adminsessions" },
);

adminSessionSchema.index({ adminId: 1, revokedAt: 1, expiresAt: -1 });

const AdminSessionModel = mongoose.model<AdminSessionDoc>("AdminSession", adminSessionSchema);

export default AdminSessionModel;
