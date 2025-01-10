import { GOOGLE_CLOUD_TASKS_QUEUE_PATH, SERVER_BASE_URL } from "../../../config/config";
import { googleCloudTasks } from "../../service-accounts/cloud-tasks";
import { sendNotification, storeNotification } from "../../service-accounts/onesignal";

export const sendBookingStartApprovedNotification = async (userId: string, bookingId: string) => {
	try {
		const notificationMessage = {
			include_aliases: { external_id: [userId] },
			contents: { en: `Your start request was approved!` },
			headings: { en: "You can start the job. Your time is being tracked." },
			data: {
				screen: "MyOrderDetails",
				bookingId: bookingId,
			},
		};
		console.log(notificationMessage);

		await sendNotification(notificationMessage);
		await storeNotification(
			"Booking Start Approved",
			"Your start request was approved!",
			userId,
			"MyOrderDetails",
			{
				bookingId,
			},
		);
		console.log("Notification sent to ids: ", userId);
	} catch (error: any) {
		console.error(
			`Error sending booking notification for booking ID ${bookingId} to available providers:`,
			error.response,
		);
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
