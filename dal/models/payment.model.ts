import mongoose, { Schema, Document } from "mongoose";

export interface Payment extends Document {
	bookingId: string;
	amount: number;
	date: Date;
	status: "pending" | "completed" | "cancelled";
	paymentIntentId: string;
	clientSecret: string;
	paymentMethod: string;
	refundId: string;
	refundStatus: "pending" | "succeeded" | "failed" | "cancelled";
	refundCreated: Date;
	refundAmount: number;
	destinationDetails: {
		type: string | undefined;
	};
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
		refundId: { type: String },
		refundStatus: { type: String, enum: ["pending", "succeeded", "failed", "cancelled"], default: "pending" },
		refundCreated: { type: Date },
		refundAmount: { type: Number },
		destinationDetails: {
			account: { type: String },
			type: { type: String },
		},
	},
	{
		timestamps: true,
	},
);

const PaymentModel = mongoose.model<Payment>("Payment", PaymentSchema);

export default PaymentModel;
