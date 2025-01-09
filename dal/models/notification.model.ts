import { Schema, model, Document } from "mongoose";

interface INotification extends Document {
	title: string;
	message: string;
	userId: string;
	screen: string;
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

const NotificationModel = model<INotification>("Notification", NotificationSchema);

export default NotificationModel;
