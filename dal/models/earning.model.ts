import mongoose, { Schema, Document, Types } from "mongoose";

export interface IEarning extends Document {
	bookingId: Types.ObjectId;
	amount: number;
	date: Date;
	status: "pending" | "completed" | "cancelled";
	completionDate?: Date;
	transferId?: string;
	/** The platform fee percentage in force when the earning was created (absent before settings: 5). */
	feePercent?: number;
}

const earningSchema = new Schema<IEarning>(
	{
		bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
		amount: { type: Number, required: true },
		date: { type: Date, default: Date.now },
		status: { type: String, enum: ["pending", "completed", "cancelled"], default: "pending" },
		completionDate: { type: Date, default: null },
		transferId: { type: String, default: null },
		feePercent: { type: Number },
	},
	{
		timestamps: true,
	},
);

earningSchema.index({ bookingId: 1 });
earningSchema.index({ status: 1, createdAt: -1 });
earningSchema.index({ createdAt: -1 });

const EarningModel = mongoose.model<IEarning>("Earning", earningSchema);

export default EarningModel;
