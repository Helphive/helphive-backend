import { Schema, model, Document, Types } from "mongoose";

export const NOTIFICATION_TYPES = [
	"booking_created",
	"booking_accepted",
	"booking_start_requested",
	"booking_started",
	"booking_completed",
	"booking_cancelled",
	"booking_expired",
	"payment_succeeded",
	"payment_refunded",
	"payout_paid",
	"account_approved",
	"account_rejected",
	"general",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

interface INotification extends Document {
	title: string;
	message: string;
	userId: string;
	screen: string;
	type: NotificationType;
	bookingId: Types.ObjectId | null;
	data: any;
	read: boolean;
	createdAt: Date;
	updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
	{
		title: {
			type: String,
			required: true,
		},
		message: {
			type: String,
			required: true,
		},
		userId: {
			type: String,
			required: true,
		},
		screen: {
			type: String,
			required: true,
		},
		type: {
			type: String,
			enum: NOTIFICATION_TYPES,
			default: "general",
		},
		bookingId: {
			type: Schema.Types.ObjectId,
			ref: "Booking",
			default: null,
		},
		data: {
			type: Schema.Types.Mixed,
		},
		read: {
			type: Boolean,
			default: false,
		},
	},
	{
		timestamps: true,
	},
);

NotificationSchema.index({ userId: 1, _id: -1 });
NotificationSchema.index({ userId: 1, read: 1 });

const NotificationModel = model<INotification>("Notification", NotificationSchema);

export default NotificationModel;
