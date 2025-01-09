import { sendNotification, storeNotification } from "../../service-accounts/onesignal";
import { googleCloudTasks } from "../../service-accounts/cloud-tasks";
import { GOOGLE_CLOUD_TASKS_QUEUE_PATH, SERVER_BASE_URL } from "../../../config/config";

export const sendBookingCompletedNotification = async (userId: string, providerId: string, bookingId: string) => {
	try {
		const notificationMessage1 = {
			include_aliases: { external_id: [userId] },
			contents: { en: `Booking Complete` },
			headings: { en: "You got the requested service." },
			data: {
				screen: "BookingDetails",
				bookingId: bookingId,
			},
		};
		const notificationMessage2 = {
			include_aliases: { external_id: [providerId] },
			contents: { en: `Booking Complete` },
			headings: { en: "You job is now complete." },
			data: {
				screen: "MyOrderDetails",
				bookingId: bookingId,
			},
		};
		console.log(notificationMessage1);
		console.log(notificationMessage2);

		await sendNotification(notificationMessage1);
		await sendNotification(notificationMessage2);
		await storeNotification("Booking Complete", "You got the requested service.", userId, "BookingDetails", {
			bookingId,
		});
		await storeNotification("Booking Complete", "You job is now complete.", providerId, "MyOrderDetails", {
			bookingId,
		});
		console.log("Notification sent to ids: ", userId);
	} catch (error: any) {
		console.error(
			`Error sending booking notification for booking ID ${bookingId} to available providers:`,
			error.response,
		);
	}
};

export const sendBookingCancelledNotification = async (userId: string, providerId: string, bookingId: string) => {
	try {
		const notificationMessage1 = {
			include_aliases: { external_id: [userId] },
			contents: { en: `Booking Cancelled` },
			headings: { en: "Your booking has been cancelled." },
			data: {
				screen: "BookingDetails",
				bookingId: bookingId,
			},
		};
		await sendNotification(notificationMessage1);
		await storeNotification("Booking Cancelled", "Your booking has been cancelled.", userId, "BookingDetails", {
			bookingId,
		});
		if (providerId) {
			const notificationMessage2 = {
				include_aliases: { external_id: [providerId] },
				contents: { en: `Booking Cancelled` },
				headings: { en: "A booking has been cancelled." },
				data: {
					screen: "MyOrderDetails",
					bookingId: bookingId,
				},
			};
			await sendNotification(notificationMessage2);
			await storeNotification(
				"Booking Cancelled",
				"A booking has been cancelled.",
				providerId,
				"MyOrderDetails",
				{
					bookingId,
				},
			);
		}

		console.log("Notification sent to ids: ", userId);
	} catch (error: any) {
		console.error(`Error sending booking cancellation notification for booking ID ${bookingId}:`, error.response);
	}
};

export const createGoogleCloudTaskPaymentTrigger = async (bookingId: string, scheduleDate: Date) => {
	const url = `${SERVER_BASE_URL}/webhook/google-cloud-tasks/earning-complete`;
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
