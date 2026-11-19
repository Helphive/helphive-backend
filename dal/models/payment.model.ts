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
	refundStatus?: "pending" | "succeeded" | "failed" | "cancelled";
	refundCreated: Date;
	refundAmount: number;
	/** When Stripe confirmed the payment (set on the first payment_intent.succeeded; absent on older payments). */
	paidAt?: Date | null;
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
		// No default: a refund exists only when refundId is set. Older documents still carry a stale "pending" here,
		// so readers check refundId first (see controllers/user-controllers/utils/payment.utils.ts).
		refundStatus: { type: String, enum: ["pending", "succeeded", "failed", "cancelled"] },
		refundCreated: { type: Date },
		refundAmount: { type: Number },
		paidAt: { type: Date },
		destinationDetails: {
			account: { type: String },
			type: { type: String },
		},
	},
	{
		timestamps: true,
	},
);

// Webhook lookups (by intent and refund id), a booking's payments, and admin lists by status and date.
PaymentSchema.index({ bookingId: 1, createdAt: -1 });
PaymentSchema.index({ paymentIntentId: 1 });
PaymentSchema.index({ refundId: 1 }, { partialFilterExpression: { refundId: { $type: "string" } } });
PaymentSchema.index({ status: 1, createdAt: -1 });
PaymentSchema.index({ createdAt: -1 });

const PaymentModel = mongoose.model<Payment>("Payment", PaymentSchema);

export default PaymentModel;
