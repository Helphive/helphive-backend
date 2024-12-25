import { sendNotification } from "../../service-accounts/onesignal";

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
		console.log("Notification sent to ids: ", userId);
	} catch (error: any) {
		console.error(
			`Error sending booking notification for booking ID ${bookingId} to available providers:`,
			error.response,
		);
	}
};
