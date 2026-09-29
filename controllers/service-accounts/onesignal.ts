import axios from "axios";
import NotificationModel, { NotificationType } from "../../dal/models/notification.model";

const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID;
const ONE_SIGNAL_REST_API_KEY = process.env.ONE_SIGNAL_REST_API_KEY;

export const oneSignalApi = axios.create({
	baseURL: "https://api.onesignal.com/",
	headers: {
		"Content-Type": "application/json",
		Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}`,
	},
});

export const sendNotification = async (data: any) => {
	try {
		const response = await oneSignalApi.post("/notifications", {
			app_id: ONE_SIGNAL_APP_ID,
			target_channel: "push",
			...data,
		});
		return response.data;
	} catch (error: any) {
		// A failed push must not stop the caller from storing the in-app notification.
		console.error("Error sending notification:", error?.response?.data ?? error?.message);
		return null;
	}
};

export const storeNotification = async (
	title: string,
	message: string,
	userId: string,
	screen: string,
	type: NotificationType = "general",
	bookingId: string | null = null,
	data?: any,
) => {
	try {
		await NotificationModel.create({
			title,
			message,
			userId,
			screen,
			type,
			bookingId,
			data: bookingId ? { bookingId, ...data } : data,
		});
	} catch (error) {
		console.error("Error storing notification");
		throw error;
	}
};
