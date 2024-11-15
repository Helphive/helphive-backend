import mongoose, { Schema, Document, Model } from "mongoose";

interface ProviderApplicationModel extends Document {
	firstName: string;
	lastName: string;
	email: string;
	phone: string;
	country: string;
	state: string;
	city: string;
	street: string;
	id: string;
	dbs: string;
	resume: string;
	profile: string;
	createdAt: Date;
	updatedAt: Date;
	status: string;
	jobTypes: {
		publicAreaAttendant: boolean;
		roomAttendant: boolean;
		linenPorter: boolean;
	};
	rejectReason: string;
}

const providerApplicationSchema: Schema = new Schema({
	firstName: { type: String, required: true },
	lastName: { type: String, required: true },
	email: { type: String, required: true },
	phone: { type: String, required: true },
	country: { type: String, required: true },
	state: { type: String, required: true },
	city: { type: String, required: true },
	street: { type: String, required: true },
	id: { type: String, required: true },
	dbs: { type: String, required: true },
	resume: { type: String, required: true },
	profile: { type: String, required: true },
	createdAt: { type: Date, default: Date.now },
	updatedAt: { type: Date, default: Date.now },
	status: { type: String, required: true },
	jobTypes: {
		publicAreaAttendant: { type: Boolean, default: false },
		roomAttendant: { type: Boolean, default: false },
		linenPorter: { type: Boolean, default: false },
	},
	rejectReason: { type: String, default: "" },
});

const ProviderApplicationModel: Model<ProviderApplicationModel> = mongoose.model<ProviderApplicationModel>(
	"ProviderApplication",
	providerApplicationSchema,
);

export default ProviderApplicationModel;
