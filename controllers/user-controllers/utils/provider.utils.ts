import stripe from "../../service-accounts/stripe";
import { sendNotification, storeNotification } from "../../service-accounts/onesignal";
import { describeBooking } from "./booking.utils";
import { CLIENT_BASE_URL } from "../../../config/config";
import { stripeOnboardingUrls, type AppFlavor } from "../../../lib/appIdentity";
import log from "../../../lib/logger";

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
		log.error(
			"sending_booking_start_failed",
			`Error sending booking start request notification for booking ID ${bookingId}`,
			error,
		);
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
		log.error(
			"sending_booking_accepted_failed",
			`Error sending booking accepted notification for booking ID ${bookingId}`,
			error,
		);
	}
};

export const PROVIDER_ONLINE_TITLE = "You're online";
export const PROVIDER_ONLINE_MESSAGE =
	"We'll notify you when a job is available within 25 km, even with the app closed. Switch off in the app when you're done.";

/**
 * Confirms to a provider who just switched on that they are available and will hear about jobs by push (the app need
 * not stay open). A push only: it is not kept in the notifications list, and it opens nothing in particular. Never throws.
 */
export const sendProviderOnlineNotification = async (providerId: string) => {
	try {
		await sendNotification({
			include_aliases: { external_id: [providerId] },
			headings: { en: PROVIDER_ONLINE_TITLE },
			contents: { en: PROVIDER_ONLINE_MESSAGE },
			data: { type: "provider_online" },
			// One per person: switching on again replaces the earlier one in the browser instead of stacking.
			web_push_topic: "provider-online",
		});
	} catch (error) {
		log.error("sending_provider_online_failed", "Error sending the provider online notification", error);
	}
};

/** Stripe onboarding link whose return and refresh URLs remember which app asked (lib/appIdentity.ts). */
export const generateAccountLink = async (connectedAccountId: string, flavor: AppFlavor = "legacy") => {
	const accountLink = await stripe.accountLinks.create({
		account: connectedAccountId,
		...stripeOnboardingUrls(CLIENT_BASE_URL, flavor),
		type: "account_onboarding",
	});

	return accountLink.url;
};
