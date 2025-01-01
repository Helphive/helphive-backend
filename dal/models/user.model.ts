import bcrypt from "bcrypt";
import mongoose, { Schema, Document, Model } from "mongoose";

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
	isEmailVerified: boolean;
	emailVerificationTokens: string[];
	password: string;
	resetPasswordTokens: string[];
	refreshToken: string[];
	sessionId: string;
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
}

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
		isEmailVerified: { type: Boolean, default: false },
		emailVerificationTokens: { type: [String], default: [] },
		password: { type: String, required: true, minlength: 8 },
		resetPasswordTokens: { type: [String], default: [] },
		refreshToken: { type: [String], default: [] },
		sessionId: { type: String, default: "" },
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
	},
	{
		timestamps: true,
	},
);

// Middleware to hash password before saving
userSchema.pre("save", async function (next) {
	const user = this as IUser;
	if (user.isModified("password")) {
		const salt = await bcrypt.genSalt(10);
		user.password = await bcrypt.hash(user.password, salt);
	}
	next();
});

const UserModel: Model<IUser> = mongoose.model<IUser>("User", userSchema);

export default UserModel;
