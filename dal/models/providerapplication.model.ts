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
	/** The admin who decided it, and when (set by the decision endpoint; absent on older applications). */
	reviewedBy?: mongoose.Types.ObjectId | null;
	reviewedAt?: Date | null;
	/** Every decision, oldest first. Today an application is decided once; the history allows re-review later. */
	decisions?: {
		status: string;
		at: Date;
		by: mongoose.Types.ObjectId | null;
		byEmail: string | null;
		reason: string | null;
	}[];
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
	reviewedBy: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
	reviewedAt: { type: Date, default: null },
	decisions: {
		type: [
			{
				_id: false,
				status: { type: String, required: true },
				at: { type: Date, required: true },
				by: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
				byEmail: { type: String, default: null },
				reason: { type: String, default: null },
			},
		],
		default: undefined,
	},
});

// Admin lists: the review queue (pending, oldest first) and decided applications by date; lookup by applicant email.
providerApplicationSchema.index({ status: 1, createdAt: 1 });
providerApplicationSchema.index({ status: 1, reviewedAt: -1 });
providerApplicationSchema.index({ email: 1 });
// Global search: case-insensitive prefixes (queries must pass SEARCH_COLLATION).
providerApplicationSchema.index({ email: 1 }, { name: "email_ci", collation: { locale: "en", strength: 2 } });
providerApplicationSchema.index({ lastName: 1 }, { name: "lastName_ci", collation: { locale: "en", strength: 2 } });
providerApplicationSchema.index({ firstName: 1 }, { name: "firstName_ci", collation: { locale: "en", strength: 2 } });

const ProviderApplicationModel: Model<ProviderApplicationModel> = mongoose.model<ProviderApplicationModel>(
	"ProviderApplication",
	providerApplicationSchema,
);

export default ProviderApplicationModel;
