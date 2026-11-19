import mongoose, { Schema, Document, Model, Types } from "mongoose";
import { ADMIN_ROLES, type AdminRole } from "../../config/adminPermissions";

export interface AdminRecoveryCode {
	hash: string;
	usedAt?: Date | null;
}

export interface AdminMfa {
	enabled: boolean;
	/** AES-256-GCM sealed base32 secret (lib/secretBox.ts). */
	secret?: string | null;
	/** Secret awaiting confirmation during enrolment. */
	pendingSecret?: string | null;
	pendingCreatedAt?: Date | null;
	enabledAt?: Date | null;
	/** Highest TOTP time step accepted so far; a code at or before it is refused (no replay). */
	lastUsedStep?: number | null;
	recoveryCodes: AdminRecoveryCode[];
}

export interface Admin extends Document {
	_id: Types.ObjectId;
	firstName: string;
	lastName: string;
	email: string;
	password: string;
	// Legacy flags, still read: superAdmin => super admin; otherwise operations (see config/adminPermissions.ts).
	// Kept in step with `role` whenever the role is written.
	roles: {
		admin: boolean;
		superAdmin: boolean;
	};
	/** Set on admins created or edited since roles were introduced. Absent on older documents. */
	role?: AdminRole;
	// Every admin token carries the version it was issued under; raising it revokes all of them (sign out everywhere).
	tokenVersion: number;
	disabled?: boolean;
	disabledAt?: Date | null;
	/** Set for a server-generated one-time password; the admin may only change their password until it is cleared. */
	mustChangePassword?: boolean;
	temporaryPasswordExpiresAt?: Date | null;
	passwordChangedAt?: Date | null;
	lastLoginAt?: Date | null;
	createdBy?: Types.ObjectId | null;
	mfa?: AdminMfa;
	createdAt: Date;
	updatedAt: Date;
}

const adminSchema: Schema = new Schema({
	firstName: { type: String, required: true },
	lastName: { type: String, required: true },
	email: { type: String, required: true, unique: true },
	password: { type: String, required: true },
	roles: {
		admin: { type: Boolean, default: false },
		superAdmin: { type: Boolean, default: false },
	},
	role: { type: String, enum: ADMIN_ROLES },
	tokenVersion: { type: Number, default: 0 },
	disabled: { type: Boolean, default: false },
	disabledAt: { type: Date, default: null },
	mustChangePassword: { type: Boolean, default: false },
	temporaryPasswordExpiresAt: { type: Date, default: null },
	passwordChangedAt: { type: Date, default: null },
	lastLoginAt: { type: Date, default: null },
	createdBy: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
	mfa: {
		enabled: { type: Boolean, default: false },
		secret: { type: String, default: null },
		pendingSecret: { type: String, default: null },
		pendingCreatedAt: { type: Date, default: null },
		enabledAt: { type: Date, default: null },
		lastUsedStep: { type: Number, default: null },
		recoveryCodes: {
			type: [{ _id: false, hash: { type: String, required: true }, usedAt: { type: Date, default: null } }],
			default: [],
		},
	},
	createdAt: { type: Date, default: Date.now },
	updatedAt: { type: Date, default: Date.now },
});

adminSchema.index({ role: 1 });
adminSchema.index({ createdAt: -1 });

// The admin login and account responses return the document. Credentials and second-factor material stay on the
// server; the response says only whether two-step sign-in is on.
const stripSecrets = (_doc: unknown, ret: Record<string, unknown>) => {
	const mfa = ret.mfa as { enabled?: boolean } | undefined;
	delete ret.password;
	delete ret.tokenVersion;
	delete ret.mfa;
	delete ret.temporaryPasswordExpiresAt;
	ret.mfaEnabled = !!mfa?.enabled;
	return ret;
};
adminSchema.set("toJSON", { transform: stripSecrets });
adminSchema.set("toObject", { transform: stripSecrets });

const AdminModel: Model<Admin> = mongoose.model<Admin>("Admin", adminSchema);

export default AdminModel;
