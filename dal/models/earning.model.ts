import mongoose, { Schema, Document, Types } from "mongoose";

export interface IEarning extends Document {
	bookingId: Types.ObjectId;
	amount: number;
	date: Date;
	status: "pending" | "completed" | "cancelled";
	paidDate?: Date;
}

const earningSchema = new Schema<IEarning>(
	{
		bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
		amount: { type: Number, required: true },
		date: { type: Date, default: Date.now },
		status: { type: String, enum: ["pending", "completed", "cancelled"], default: "pending" },
		paidDate: { type: Date, default: null },
	},
	{
		timestamps: true,
	},
);

const EarningModel = mongoose.model<IEarning>("Earning", earningSchema);

export default EarningModel;