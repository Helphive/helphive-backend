import { sendNotification } from "../service-accounts/onesignal";

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
		const notificationMessage2 = {
			include_aliases: { external_id: [providerId] },
			contents: { en: `Booking Cancelled` },
			headings: { en: "A booking has been cancelled." },
			data: {
				screen: "MyOrderDetails",
				bookingId: bookingId,
			},
		};
		console.log(notificationMessage1);
		console.log(notificationMessage2);

		await sendNotification(notificationMessage1);
		await sendNotification(notificationMessage2);
		console.log("Notification sent to ids: ", userId);
	} catch (error: any) {
		console.error(`Error sending booking cancellation notification for booking ID ${bookingId}:`, error.response);
	}
};
