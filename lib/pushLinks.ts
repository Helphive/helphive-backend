// Where a push notification opens in the web app, and how it looks in a browser. Pure functions; the one caller is
// sendNotification (controllers/service-accounts/onesignal.ts), which adds the result to every OneSignal payload.
//
// `web_url`, `web_push_topic`, `chrome_web_icon` and `chrome_web_badge` are OneSignal parameters that only web
// subscriptions read, so the mobile app keeps getting exactly the heading, content, `data` and targeting it gets today.
// The paths are routes of the web app (helphive-web src/App.tsx). The web origin is the one the email and chat links
// already use (WEB_APP_URL, lib/appIdentity.ts).

const OBJECT_ID = /^[a-f\d]{24}$/i;
const id = (value: unknown): string | null => (typeof value === "string" && OBJECT_ID.test(value) ? value : null);

export type PushRole = "customer" | "provider";

export interface PushLinkInput {
	/** The `data` object a notification already carries ({ screen, type, bookingId, senderUid, ... }). */
	data?: Record<string, unknown> | null;
	/** Who receives it, when known. Only changes where a booking opens (customer or provider area). */
	role?: PushRole | null;
}

/**
 * The web path for a notification: booking detail, order detail, the conversation with that person, earnings, provider
 * application status; anything else opens the dashboard (/home sends each person to their own area). Always a path on
 * the web app, built only from validated ids, so nothing in a payload can point somewhere else.
 */
export const webPushPath = ({ data, role = null }: PushLinkInput): string => {
	const screen = typeof data?.screen === "string" ? data.screen : "";
	const type = typeof data?.type === "string" ? data.type : "";
	const bookingId = id(data?.bookingId);
	const senderUid = id(data?.senderUid);

	if (screen === "Chat" || type === "chat_message") return senderUid ? `/chat/${senderUid}` : "/home";
	if (type === "account_approved") return "/provider/approved";
	if (type === "account_rejected") return "/provider/rejected";
	switch (screen) {
		case "BookingDetails":
			if (!bookingId) return "/home";
			return role === "provider" ? `/provider/my-orders/${bookingId}` : `/user/booking/${bookingId}`;
		case "MyOrderDetails":
			return bookingId ? `/provider/my-orders/${bookingId}` : "/home";
		case "AcceptOrder":
			return bookingId ? `/provider/orders/${bookingId}` : "/home";
		case "Earnings":
			return "/provider/earnings";
		default:
			return "/home";
	}
};

/** One browser notification per conversation or booking: a newer one replaces the older one instead of stacking. */
export const webPushTopic = ({ data }: PushLinkInput): string | null => {
	const senderUid = id(data?.senderUid);
	if ((data?.screen === "Chat" || data?.type === "chat_message") && senderUid) return `chat-${senderUid}`;
	const bookingId = id(data?.bookingId);
	return bookingId ? `booking-${bookingId}` : null;
};

/** The OneSignal fields that only web subscriptions use. `webBase` is the web app origin (webAppUrl()). */
export const webPushFields = (input: PushLinkInput, webBase: string) => ({
	web_url: `${webBase}${webPushPath(input)}`,
	...(webPushTopic(input) ? { web_push_topic: webPushTopic(input) } : {}),
	chrome_web_icon: `${webBase}/icon.png`,
	// Android Chrome draws the status-bar badge from the alpha channel only: the bee on a transparent background.
	chrome_web_badge: `${webBase}/logo-mark.png`,
});
