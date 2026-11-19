import bcrypt from "bcrypt";
import mongoose, { Schema, Document, Model } from "mongoose";
import { canonicalEmail } from "../../lib/emailAddress";

export interface UserSession {
	sessionId: string;
	refreshTokens: string[];
	lastUsedAt: Date;
	// Device details, recorded from the request when the session starts and refreshed on each token refresh.
	// Absent on sessions started before they were recorded.
	createdAt?: Date;
	lastIp?: string;
	userAgent?: string;
	platform?: string;
	appVersion?: string;
	deviceId?: string;
	/** CometChat auth token issued for this session (encrypted, lib/chat/chatTokens.ts); revoked when it ends. */
	chatToken?: string;
	/** OneSignal external id this session's device signed in with (lib/push.ts); only active sessions get pushes. */
	pushAlias?: string;
	/** The chat conversation this device has open (no push for it while `until` is in the future). */
	chatViewing?: { withUid: string; until: Date } | null;
}

interface Roles {
	User: boolean;
	Provider: boolean;
}

interface JobType {
	id: number;
	name?: string;
}

interface IUser extends Document {
	firstName: string;
	lastName: string;
	email: string;
	/** The mailbox identity (lib/emailAddress.ts canonicalEmail), unique; absent on accounts not yet backfilled. */
	emailCanonical?: string;
	isEmailVerified: boolean;
	emailVerificationTokens: string[];
	password: string;
	resetPasswordTokens: string[];
	refreshToken: string[];
	sessionId: string;
	sessions: UserSession[];
	roles: Roles;
	providerApplications: Schema.Types.ObjectId[];
	providerAccountApproval: boolean;
	providerStatus: "inactive" | "rejected" | "pending" | "approved";
	profile: string;
	currentLocation: {
		latitude: number;
		longitude: number;
	} | null;
	isProviderAvailable: boolean;
	selectedJobTypes: JobType[];
	stripeConnectedAccountId: string;
	availableBalance: number;
	createdAt: Date;
	updatedAt: Date;
	phone: string;
	country: string;
	state: string;
	city: string;
	street: string;
	/** Set by an admin. A suspended account cannot sign in, refresh, call the API or use the provider socket. */
	suspended: boolean;
	suspendedAt?: Date | null;
	suspendedBy?: mongoose.Types.ObjectId | null;
	suspendedReason?: string | null;
	/** Last sign-in or token refresh (about every 10 minutes while an app is open). Absent before it was recorded. */
	lastActiveAt?: Date | null;
	/** When currentLocation was last written (websocket or HTTP availability update). */
	locationUpdatedAt?: Date | null;
	/** Set by an admin: no chat session is issued and CometChat denies every chat action. */
	chatSuspended?: boolean;
	chatSuspendedAt?: Date | null;
	chatSuspendedBy?: mongoose.Types.ObjectId | null;
	chatSuspendedReason?: string | null;
	/** When this user was last confirmed to exist in CometChat. */
	chatUserReadyAt?: Date | null;
	/** Set while a risk payout hold is active (lib/risk/holds.ts): "hold" stops payouts and earning releases, "review" the next payout. */
	payoutHold?: "hold" | "review" | null;
}

// Credentials that must never leave the server. Internal code reads them from the document itself.
export const USER_SECRET_FIELDS = [
	"password",
	"refreshToken",
	"sessionId",
	"sessions",
	"resetPasswordTokens",
	"emailVerificationTokens",
	// Internal duplicate-guard key; responses keep their shape and the demo-admin masking never sees it.
	"emailCanonical",
] as const;

// Admin-only fields: the person never sees who suspended them or the admin's reason.
export const USER_ADMIN_ONLY_FIELDS = [
	"suspendedBy",
	"suspendedReason",
	"chatSuspendedBy",
	"chatSuspendedReason",
	"payoutHold",
] as const;

// Projection for populating or lean-querying users, which bypass the schema transform below.
export const SAFE_USER_SELECT = [...USER_SECRET_FIELDS, ...USER_ADMIN_ONLY_FIELDS]
	.map((field) => `-${field}`)
	.join(" ");

const stripSecrets = (_doc: unknown, ret: Record<string, unknown>) => {
	for (const field of USER_SECRET_FIELDS) delete ret[field];
	for (const field of USER_ADMIN_ONLY_FIELDS) delete ret[field];
	return ret;
};

const rolesSchema = new Schema<Roles>(
	{
		User: { type: Boolean, required: true },
		Provider: { type: Boolean, required: true },
	},
	{ _id: false },
);

const userSchema = new Schema<IUser>(
	{
		firstName: { type: String, required: true, minlength: 1, maxlength: 50 },
		lastName: { type: String, required: true, minlength: 1, maxlength: 50 },
		email: { type: String, required: true, unique: true, match: /.+\@.+\..+/ },
		emailCanonical: { type: String },
		isEmailVerified: { type: Boolean, default: false },
		emailVerificationTokens: { type: [String], default: [] },
		password: { type: String, required: true, minlength: 8 },
		resetPasswordTokens: { type: [String], default: [] },
		refreshToken: { type: [String], default: [] },
		sessionId: { type: String, default: "" },
		// One entry per signed-in device. refreshTokens holds the newest token first plus the previous few,
		// so a refresh that raced or was interrupted mid-flight does not sign the device out.
		sessions: {
			type: [
				{
					_id: false,
					sessionId: { type: String, required: true },
					refreshTokens: { type: [String], default: [] },
					lastUsedAt: { type: Date, default: Date.now },
					createdAt: { type: Date },
					lastIp: { type: String },
					userAgent: { type: String },
					platform: { type: String },
					appVersion: { type: String },
					deviceId: { type: String },
					chatToken: { type: String },
					pushAlias: { type: String },
					chatViewing: {
						type: new Schema({ withUid: String, until: Date }, { _id: false }),
						default: undefined,
					},
				},
			],
			default: [],
		},
		roles: { type: rolesSchema, required: true },
		providerApplications: [{ type: Schema.Types.ObjectId, ref: "ProviderApplication" }],
		providerAccountApproval: { type: Boolean, default: false },
		providerStatus: { type: String, default: "inactive" },
		profile: { type: String },
		currentLocation: {
			latitude: { type: Number, default: null },
			longitude: { type: Number, default: null },
		},
		isProviderAvailable: { type: Boolean, default: false },
		selectedJobTypes: {
			type: [
				{
					id: { type: Number, required: true },
					name: {
						type: String,
						required: false,
						default: function (this: { id: number }) {
							switch (this.id) {
								case 1:
									return "Public Area Attendant";
								case 2:
									return "Room Attendant";
								case 3:
									return "Linen Porter";
								default:
									return "";
							}
						},
					},
				},
			],
			default: [],
		},
		stripeConnectedAccountId: { type: String, default: "" },
		availableBalance: { type: Number, default: 0, min: 0 },
		phone: { type: String, required: false },
		country: { type: String, required: false },
		state: { type: String, required: false },
		city: { type: String, required: false },
		street: { type: String, required: false },
		suspended: { type: Boolean, default: false },
		suspendedAt: { type: Date },
		suspendedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
		suspendedReason: { type: String },
		lastActiveAt: { type: Date },
		locationUpdatedAt: { type: Date },
		chatSuspended: { type: Boolean, default: false },
		chatSuspendedAt: { type: Date },
		chatSuspendedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
		chatSuspendedReason: { type: String },
		chatUserReadyAt: { type: Date },
		payoutHold: { type: String, enum: ["hold", "review"] },
	},
	{
		timestamps: true,
		toJSON: { transform: stripSecrets },
		toObject: { transform: stripSecrets },
	},
);

// Admin lists (customers and providers by status and sign-up date), and lookups the API already makes.
userSchema.index({ createdAt: -1 });
userSchema.index({ "roles.Provider": 1, providerStatus: 1, createdAt: -1 });
userSchema.index({ "roles.User": 1, createdAt: -1 });
userSchema.index({ providerApplications: 1 });
userSchema.index({ "sessions.sessionId": 1 });
userSchema.index({ "sessions.pushAlias": 1 }, { partialFilterExpression: { "sessions.pushAlias": { $exists: true } } });
userSchema.index({ isProviderAvailable: 1, providerStatus: 1 });
// Operations console: suspended accounts, last-active filter and sort, and the search. The search indexes compare
// case-insensitively (collation strength 2) so a prefix is an index range; queries must pass SEARCH_COLLATION.
userSchema.index({ suspended: 1, suspendedAt: -1 }, { partialFilterExpression: { suspended: true } });
userSchema.index({ lastActiveAt: -1 });
userSchema.index({ email: 1 }, { name: "email_ci", collation: { locale: "en", strength: 2 } });
userSchema.index({ firstName: 1 }, { name: "firstName_ci", collation: { locale: "en", strength: 2 } });
userSchema.index({ lastName: 1 }, { name: "lastName_ci", collation: { locale: "en", strength: 2 } });
userSchema.index({ phone: 1 });
// Duplicate guard: one account per mailbox (Name@gmail.com, name@gmail.com and n.ame+x@googlemail.com are one).
// Partial, so accounts without the field (until scripts/backfill-email-canonical.ts runs) are not in it.
userSchema.index(
	{ emailCanonical: 1 },
	{ name: "emailCanonical_unique", unique: true, partialFilterExpression: { emailCanonical: { $type: "string" } } },
);

// Middleware to hash password before saving
userSchema.pre("save", async function (next) {
	const user = this as IUser;
	// Only on create or an email change, so saving an old account never trips the unique index.
	if (user.isNew || user.isModified("email")) user.emailCanonical = canonicalEmail(user.email);
	if (user.isModified("password")) {
		const salt = await bcrypt.genSalt(10);
		user.password = await bcrypt.hash(user.password, salt);
	}
	next();
});

const UserModel: Model<IUser> = mongoose.model<IUser>("User", userSchema);

export default UserModel;
