import stripe from "../../service-accounts/stripe";
import { sendNotification } from "../../service-accounts/onesignal";

export const sendBookingStartedNotification = async (userId: string, bookingId: string) => {
	try {
		const notificationMessage = {
			include_aliases: { external_id: [userId] },
			contents: { en: `Your booking requires attention!` },
			headings: { en: "Please approve the provider's request to start the job." },
			data: {
				screen: "BookingDetails",
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

export const generateAccountLink = async (connectedAccountId: string) => {
	const accountLink = await stripe.accountLinks.create({
		account: connectedAccountId,
		refresh_url: `${process.env.CLIENT_BASE_URL}/stripe-onboarding?refresh=true`,
		return_url: `${process.env.CLIENT_BASE_URL}/stripe-onboarding`,
		type: "account_onboarding",
	});

	return accountLink.url;
};