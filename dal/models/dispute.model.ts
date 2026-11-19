import mongoose, { Schema, Types } from "mongoose";

// A card dispute (chargeback) on a customer's payment, kept from Stripe's charge.dispute.* webhook events
// (lib/disputes.ts decides each change). Amounts in dollars as elsewhere; no card or bank details are stored.
export interface DisputeDoc {
	_id: Types.ObjectId;
	disputeId: string;
	chargeId?: string | null;
	paymentIntentId?: string | null;
	paymentId?: Types.ObjectId | null;
	bookingId?: Types.ObjectId | null;
	userId?: Types.ObjectId | null;
	providerId?: Types.ObjectId | null;
	amount: number;
	currency: string;
	reason: string;
	status: string;
	evidenceDueBy?: Date | null;
	isChargeRefundable: boolean;
	livemode: boolean;
	openedAt: Date;
	lastEventAt: Date;
	fundsWithdrawnAt?: Date | null;
	fundsReinstatedAt?: Date | null;
	closedAt?: Date | null;
	outcome?: "won" | "lost" | "warning_closed" | null;
	history: { eventId: string; type: string; at: Date; status: string }[];
	version: number;
	createdAt: Date;
	updatedAt: Date;
}

const disputeSchema = new Schema<DisputeDoc>(
	{
		disputeId: { type: String, required: true, unique: true },
		chargeId: { type: String, default: null },
		paymentIntentId: { type: String, default: null },
		paymentId: { type: Schema.Types.ObjectId, ref: "Payment", default: null },
		bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
		userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
		providerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
		amount: { type: Number, required: true },
		currency: { type: String, default: "usd" },
		reason: { type: String, default: "general" },
		status: { type: String, required: true },
		evidenceDueBy: { type: Date, default: null },
		isChargeRefundable: { type: Boolean, default: false },
		livemode: { type: Boolean, default: false },
		openedAt: { type: Date, required: true },
		lastEventAt: { type: Date, required: true },
		fundsWithdrawnAt: { type: Date, default: null },
		fundsReinstatedAt: { type: Date, default: null },
		closedAt: { type: Date, default: null },
		outcome: { type: String, default: null },
		history: {
			type: [{ eventId: String, type: { type: String }, at: Date, status: String, _id: false }],
			default: [],
		},
		version: { type: Number, default: 0 },
	},
	{ timestamps: true, collection: "disputes" },
);

disputeSchema.index({ status: 1, evidenceDueBy: 1 });
disputeSchema.index({ openedAt: -1 });
disputeSchema.index({ paymentId: 1 });
disputeSchema.index({ bookingId: 1 });

const DisputeModel = mongoose.model<DisputeDoc>("Dispute", disputeSchema);

export default DisputeModel;
