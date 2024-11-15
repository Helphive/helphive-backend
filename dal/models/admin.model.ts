import mongoose, { Schema, Document, Model } from "mongoose";

export interface Admin extends Document {
	firstName: string;
	lastName: string;
	email: string;
	password: string;
	refreshToken: string[];
	roles: {
		admin: boolean;
		superAdmin: boolean;
	};
	createdAt: Date;
	updatedAt: Date;
}

const adminSchema: Schema = new Schema({
	firstName: { type: String, required: true, unique: true },
	lastName: { type: String, required: true, unique: true },
	email: { type: String, required: true, unique: true },
	password: { type: String, required: true },
	roles: {
		admin: { type: Boolean, default: false },
		superAdmin: { type: Boolean, default: false },
	},
	refreshToken: { type: [String] },
	createdAt: { type: Date, default: Date.now },
	updatedAt: { type: Date, default: Date.now },
});

const AdminModel: Model<Admin> = mongoose.model<Admin>("Admin", adminSchema);

export default AdminModel;
