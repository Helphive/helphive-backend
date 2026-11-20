import axios from "axios";
import NotificationModel, { NotificationType } from "../../dal/models/notification.model";
import UserModel from "../../dal/models/user.model";
import { pushTargets } from "../../lib/push";
import { webPushFields } from "../../lib/pushLinks";
import { webAppUrl } from "../../lib/appIdentity";
import log from "../../lib/logger";

const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID;
const ONE_SIGNAL_REST_API_KEY = process.env.ONE_SIGNAL_REST_API_KEY;

export const oneSignalApi = axios.create({
	baseURL: "https://api.onesignal.com/",
	timeout: 5000,
	headers: {
		"Content-Type": "application/json",
		Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}`,
	},
});

const isObjectId = (value: unknown) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);

/** OneSignal accepts up to 20,000 aliases per call. */
const MAX_ALIASES = 20_000;

/**
 * The OneSignal external ids for these users, from their active sessions now (lib/push.ts). A person with no active
 * session (signed out everywhere, suspended) is not reached at all.
 */
export const resolvePushAliases = async (userIds: string[]): Promise<string[]> => {
	const ids = [...new Set(userIds.filter(isObjectId))];
	if (!ids.length) return [];
	const users = await UserModel.find({ _id: { $in: ids } })
		.select("sessions.sessionId sessions.pushAlias sessions.lastUsedAt sessionId suspended")
		.lean()
		.exec();
	return pushTargets(users as any[]);
};

/**
 * Sends a push. Callers name people with `include_aliases.external_id: [userId, ...]`; this replaces them with the
 * external ids of those people's active sessions, so only devices still signed in to the account are reached.
 */
export const sendNotification = async (data: any) => {
	try {
		const requested: unknown = data?.include_aliases?.external_id;
		let payload = data;
		if (Array.isArray(requested)) {
			const aliases = await resolvePushAliases(requested.map(String));
			if (!aliases.length) return null;
			payload = { ...data, include_aliases: { external_id: aliases.slice(0, MAX_ALIASES) } };
		}
		const response = await oneSignalApi.post("/notifications", {
			app_id: ONE_SIGNAL_APP_ID,
			target_channel: "push",
			// Web-only fields (link, replace-instead-of-stack topic, icons); mobile subscriptions ignore them.
			...webPushFields({ data: payload?.data }, webAppUrl()),
			...payload,
		});
		return response.data;
	} catch (error: any) {
		// A failed push must not stop the caller from storing the in-app notification. Never log the payload.
		log.error("Error sending notification", { status: error?.response?.status ?? null, code: error?.code ?? null });
		return null;
	}
};

/**
 * Detaches these external ids from whatever device holds them in OneSignal, so nothing sent to them can arrive (the
 * server also stops targeting them). Fire and forget; a missing alias is fine.
 */
export const forgetPushAliases = (aliases: string[]) => {
	for (const alias of aliases) {
		oneSignalApi
			.delete(`/apps/${ONE_SIGNAL_APP_ID}/users/by/external_id/${encodeURIComponent(alias)}/identity/external_id`)
			.catch((error: any) => {
				if (error?.response?.status !== 404) {
					log.warn("Could not remove a push alias in OneSignal", { status: error?.response?.status ?? null });
				}
			});
	}
};

export const storeNotification = async (
	title: string,
	message: string,
	userId: string,
	screen: string,
	type: NotificationType = "general",
	bookingId: string | null = null,
	data?: any,
) => {
	try {
		await NotificationModel.create({
			title,
			message,
			userId,
			screen,
			type,
			bookingId,
			data: bookingId ? { bookingId, ...data } : data,
		});
	} catch (error) {
		log.error("Error storing notification");
		throw error;
	}
};
