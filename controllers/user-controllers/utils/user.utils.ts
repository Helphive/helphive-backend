import { describeBooking } from "./booking.utils";
import { GOOGLE_CLOUD_TASKS_QUEUE_PATH, SERVER_BASE_URL } from "../../../config/config";
import { googleCloudTasks } from "../../service-accounts/cloud-tasks";
import { sendNotification, storeNotification } from "../../service-accounts/onesignal";
import { getSettings } from "../../../lib/settings";
import { noShowCheckAt, noShowDueAt } from "../../../lib/noShow";
import log from "../../../lib/logger";

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
		log.error(
			"sending_booking_started_failed",
			`Error sending booking started notification for booking ID ${bookingId}`,
			error,
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

/**
 * Schedules the no-show check for an accepted booking (lib/noShow.ts): at `checkAt` the task cancels and refunds it if
 * nobody started it, or re-arms itself when it is not due yet. Throws when the task cannot be created.
 */
export const createGoogleCloudTaskBookingNoShowTrigger = async (bookingId: string, checkAt: Date) => {
	await googleCloudTasks.createTask({
		parent: GOOGLE_CLOUD_TASKS_QUEUE_PATH,
		task: {
			httpRequest: {
				httpMethod: "POST" as const,
				url: `${SERVER_BASE_URL}/webhook/google-cloud-tasks/booking-no-show`,
				body: Buffer.from(JSON.stringify({ bookingId })).toString("base64"),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.GOOGLE_CLOUD_TASKS_SECRET}`,
				},
			},
			// Rounded up: a task that ran a fraction of a second early would find the booking not due yet.
			scheduleTime: { seconds: Math.ceil(checkAt.getTime() / 1000) },
		},
	});
};

/**
 * For the accept endpoint: schedules the no-show check without ever failing the acceptance. A booking whose check
 * could not be scheduled still shows on the console's attention list once it is late.
 */
export const scheduleBookingNoShowCheck = async (
	booking: { _id: unknown; startDate?: Date | string | null; hours?: number | null },
	now = new Date(),
) => {
	try {
		const dueAt = noShowDueAt(booking, (await getSettings())["bookings.noShowGraceMinutes"]);
		if (!dueAt) return false;
		await createGoogleCloudTaskBookingNoShowTrigger(String(booking._id), noShowCheckAt(dueAt, now));
		return true;
	} catch (error) {
		log.error(
			"schedule_no_show_failed",
			`Could not schedule the no-show check for booking ID ${String(booking._id)}`,
			error,
		);
		return false;
	}
};

/** Tells both people that a booking nobody started was cancelled (the customer is refunded in full). */
export const sendBookingNoShowNotification = async (userId: string, providerId: string, booking: any) => {
	const bookingId = booking._id.toString();
	try {
		const details = describeBooking(booking);
		const recipients = [
			{
				id: userId,
				screen: "BookingDetails",
				message: `Your ${details} booking was not started, so it was cancelled. Any payment will be refunded.`,
			},
			{
				id: providerId,
				screen: "MyOrderDetails",
				message: `The ${details} job was not started before the shift ended, so it was cancelled.`,
			},
		];
		const title = "Booking cancelled";
		for (const { id, screen, message } of recipients) {
			await sendNotification({
				include_aliases: { external_id: [id] },
				headings: { en: title },
				contents: { en: message },
				data: { screen, bookingId, type: "booking_cancelled" },
			});
			await storeNotification(title, message, id, screen, "booking_cancelled", bookingId);
		}
	} catch (error) {
		log.error(
			"sending_started_cancellation_failed",
			`Error sending the not-started cancellation notification for booking ID ${bookingId}`,
			error,
		);
	}
};
