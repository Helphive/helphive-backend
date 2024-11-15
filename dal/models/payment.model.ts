import mongoose, { Schema, Document } from "mongoose";

export interface Payment extends Document {
	bookingId: string;
	amount: number;
	date: Date;
	status: string;
	paymentIntentId: string;
	clientSecret: string;
	paymentMethod: string;
}

const PaymentSchema: Schema = new Schema(
	{
		bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
		amount: { type: Number, required: true },
		date: { type: Date, default: Date.now },
		status: { type: String, enum: ["pending", "completed", "cancelled"], default: "pending" },
		paymentIntentId: { type: String },
		clientSecret: { type: String },
		paymentMethod: { type: String },
	},
	{
		timestamps: true,
	},
);

const PaymentModel = mongoose.model<Payment>("Payment", PaymentSchema);

export default PaymentModel;
