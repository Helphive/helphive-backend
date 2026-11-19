import mongoose, { Schema, Document } from "mongoose";

/** One admin refund. The admin and the reason are in the audit log, never on the payment (customers read payments). */
export interface PaymentRefund {
	/** Unique per refund request; the console sends it so a double submission or a retry cannot refund twice. */
	idempotencyKey: string;
	amount: number;
	/** requested: reserved, Stripe not yet confirmed; failed: Stripe refused (not counted against what is left). */
	status: "requested" | "pending" | "succeeded" | "failed" | "cancelled";
	refundId?: string | null;
	requestedAt: Date;
	createdAt?: Date | null;
	source: "admin";
}

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
	/** Admin refunds, oldest first. The top-level refund fields describe the latest refund and the total refunded. */
	refunds?: PaymentRefund[];
	/** Raised by every admin refund request; a request applies only to the version it read (no concurrent refunds). */
	refundVersion?: number;
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
		refunds: {
			type: [
				{
					_id: false,
					idempotencyKey: { type: String, required: true },
					amount: { type: Number, required: true },
					status: {
						type: String,
						enum: ["requested", "pending", "succeeded", "failed", "cancelled"],
						required: true,
					},
					refundId: { type: String, default: null },
					requestedAt: { type: Date, required: true },
					createdAt: { type: Date, default: null },
					source: { type: String, enum: ["admin"], default: "admin" },
				},
			],
			default: undefined,
		},
		refundVersion: { type: Number },
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
// Webhook lookups for earlier partial refunds, and the refunds-pending/failed counts on the operations overview.
PaymentSchema.index({ "refunds.refundId": 1 });
PaymentSchema.index(
	{ refundStatus: 1, refundCreated: -1 },
	{ partialFilterExpression: { refundId: { $type: "string" } } },
);

const PaymentModel = mongoose.model<Payment>("Payment", PaymentSchema);

export default PaymentModel;
