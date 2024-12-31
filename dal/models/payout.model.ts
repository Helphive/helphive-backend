import mongoose, { Schema, Document, Model } from "mongoose";

interface IPayout extends Document {
	userId: Schema.Types.ObjectId;
	amount: number;
	currency: string;
	payoutId: string;
	status: "pending" | "paid" | "failed" | "cancelled";
	destinationAccount: string;
	destinationDetails: {
		type: string; // "bank_account" or "card"
		last4?: string;
		country?: string;
		currency?: string;
	};
	createdAt: Date;
	updatedAt: Date;
}

const payoutSchema = new Schema<IPayout>(
	{
		userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
		amount: { type: Number, required: true },
		currency: { type: String, required: true, default: "usd" },
		payoutId: { type: String, required: true, unique: true },
		status: { type: String, enum: ["pending", "paid", "failed", "cancelled"], default: "pending" },
		destinationAccount: { type: String, required: true },
		destinationDetails: {
			type: {
				type: String, // "bank_account" or "card"
				required: true,
			},
			last4: { type: String },
			country: { type: String },
			currency: { type: String },
		},
	},
	{
		timestamps: true,
	},
);

const PayoutModel: Model<IPayout> = mongoose.model<IPayout>("Payout", payoutSchema);

export default PayoutModel;
