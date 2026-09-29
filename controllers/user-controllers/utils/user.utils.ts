import { describeBooking } from "./booking.utils";
import { GOOGLE_CLOUD_TASKS_QUEUE_PATH, SERVER_BASE_URL } from "../../../config/config";
import { googleCloudTasks } from "../../service-accounts/cloud-tasks";
import { sendNotification, storeNotification } from "../../service-accounts/onesignal";

export const sendBookingStartApprovedNotification = async (providerId: string, booking: any) => {
	const bookingId = booking._id.toString();
	try {
		const title = "Start request approved";
		const message = `The customer approved your start request for the ${describeBooking(booking)} job. Your time is now being tracked.`;

		await sendNotification({
			include_aliases: { external_id: [providerId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "MyOrderDetails", bookingId, type: "booking_started" },
		});
		await storeNotification(title, message, providerId, "MyOrderDetails", "booking_started", bookingId);
	} catch (error: any) {
		console.error(`Error sending booking started notification for booking ID ${bookingId}:`, error.response);
	}
};

export const createGoogleCloudTaskBookingExpiredTrigger = async (bookingId: string, scheduleDate: Date) => {
	const url = `${SERVER_BASE_URL}/webhook/google-cloud-tasks/booking-expired`;
	const payload = {
		bookingId,
	};
	const task = {
		parent: GOOGLE_CLOUD_TASKS_QUEUE_PATH,
		task: {
			httpRequest: {
				httpMethod: "POST" as const,
				url,
				body: Buffer.from(JSON.stringify(payload)).toString("base64"),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.GOOGLE_CLOUD_TASKS_SECRET}`,
				},
			},
			scheduleTime: {
				seconds: scheduleDate.getTime() / 1000,
			},
		},
	};
	await googleCloudTasks.createTask(task);
};
