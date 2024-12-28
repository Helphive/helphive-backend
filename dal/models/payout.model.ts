import mongoose, { Schema, Document, Model } from "mongoose";

interface IPayout extends Document {
	userId: Schema.Types.ObjectId;
	amount: number;
	transactionId: string;
	status: "pending" | "completed" | "failed";
	createdAt: Date;
	updatedAt: Date;
}

const payoutSchema = new Schema<IPayout>(
	{
		userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
		amount: { type: Number, required: true },
		transactionId: { type: String, required: true, unique: true },
		status: { type: String, enum: ["pending", "completed", "failed"], default: "pending" },
	},
	{
		timestamps: true,
	},
);

const PayoutModel: Model<IPayout> = mongoose.model<IPayout>("Payout", payoutSchema);

export default PayoutModel;
