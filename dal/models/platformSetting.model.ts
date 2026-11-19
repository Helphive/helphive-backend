import mongoose, { Schema, Types } from "mongoose";

// One document per platform setting an admin has changed (lib/settings.ts). A setting with no document uses its
// default, so an empty collection is exactly the behaviour before settings existed. `version` guards concurrent edits.
export interface PlatformSettingDoc {
	_id: Types.ObjectId;
	key: string;
	value: unknown;
	version: number;
	updatedBy?: { id: Types.ObjectId; email: string } | null;
	createdAt: Date;
	updatedAt: Date;
}

const platformSettingSchema = new Schema<PlatformSettingDoc>(
	{
		key: { type: String, required: true, unique: true },
		value: { type: Schema.Types.Mixed },
		version: { type: Number, default: 1 },
		updatedBy: {
			id: { type: Schema.Types.ObjectId, ref: "Admin" },
			email: { type: String },
		},
	},
	{ timestamps: true, collection: "platformsettings", minimize: false },
);

const PlatformSettingModel = mongoose.model<PlatformSettingDoc>("PlatformSetting", platformSettingSchema);

export default PlatformSettingModel;
