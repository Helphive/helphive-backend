import stripe from "../../service-accounts/stripe";
import { sendNotification, storeNotification } from "../../service-accounts/onesignal";
import { describeBooking } from "./booking.utils";
import { CLIENT_BASE_URL } from "../../../config/config";

export const sendBookingStartedNotification = async (userId: string, booking: any) => {
	const bookingId = booking._id.toString();
	try {
		const title = "Provider is ready to start";
		const message = `Your provider is ready to begin the ${describeBooking(booking)}. Please approve to start the job.`;

		await sendNotification({
			include_aliases: { external_id: [userId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "BookingDetails", bookingId, type: "booking_start_requested" },
		});
		await storeNotification(title, message, userId, "BookingDetails", "booking_start_requested", bookingId);
	} catch (error: any) {
		console.error(`Error sending booking start request notification for booking ID ${bookingId}:`, error.response);
	}
};

export const sendBookingAcceptedNotification = async (userId: string, providerName: string, booking: any) => {
	const bookingId = booking._id.toString();
	try {
		const title = "Booking accepted";
		const message = `${providerName} accepted your ${describeBooking(booking)} booking.`;

		await sendNotification({
			include_aliases: { external_id: [userId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "BookingDetails", bookingId, type: "booking_accepted" },
		});
		await storeNotification(title, message, userId, "BookingDetails", "booking_accepted", bookingId);
	} catch (error: any) {
		console.error(`Error sending booking accepted notification for booking ID ${bookingId}:`, error.response);
	}
};

export const generateAccountLink = async (connectedAccountId: string) => {
	const accountLink = await stripe.accountLinks.create({
		account: connectedAccountId,
		refresh_url: `${CLIENT_BASE_URL}/stripe-onboarding?refresh=true`,
		return_url: `${CLIENT_BASE_URL}/stripe-onboarding`,
		type: "account_onboarding",
	});

	return accountLink.url;
};
