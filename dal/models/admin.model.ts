import mongoose, { Schema, Document, Model } from "mongoose";

export interface Admin extends Document {
	firstName: string;
	lastName: string;
	email: string;
	password: string;
	roles: {
		admin: boolean;
		superAdmin: boolean;
	};
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
	createdAt: { type: Date, default: Date.now },
	updatedAt: { type: Date, default: Date.now },
});

// The admin login and account responses return the document; the password hash stays on the server.
const stripPassword = (_doc: unknown, ret: Record<string, unknown>) => {
	delete ret.password;
	return ret;
};
adminSchema.set("toJSON", { transform: stripPassword });
adminSchema.set("toObject", { transform: stripPassword });

const AdminModel: Model<Admin> = mongoose.model<Admin>("Admin", adminSchema);

export default AdminModel;
