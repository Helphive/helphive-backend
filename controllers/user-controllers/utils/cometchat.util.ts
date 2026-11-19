import axios from "axios";
import { COMET_CHAT_BASE_URL } from "../../../config/config";
import { USER_PROFILES_BUCKET } from "../../../config/config";
import log from "../../../lib/logger";

const apiKey = process.env.COMET_CHAT_REST_API_KEY || "";

export const createCometChatUser = async (userId: string, email: string, name: string) => {
	const url = `${COMET_CHAT_BASE_URL}/users`;
	const options = {
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			apiKey,
		},
	};

	try {
		await axios.post(
			url,
			{
				metadata: { "@private": { email } },
				uid: userId,
				name,
			},
			options,
		);
	} catch (error: any) {
		if (error.response) {
			log.error("Error Response", error.response.data);
		} else {
			log.error("Error", error.message);
		}
	}
};

export const sendCometChatMessage = async (userId: string, friendId: string) => {
	const url = `${COMET_CHAT_BASE_URL}/messages`;
	const headers = {
		accept: "application/json",
		"content-type": "application/json",
		// Was a hard-coded key (public in git history since 92d2ae0): it must be rotated in CometChat.
		apikey: apiKey,
		onBehalfOf: userId,
	};

	const payload = {
		category: "message",
		type: "text",
		data: { text: "A booking was accepted." },
		receiver: friendId,
		receiverType: "user",
	};

	try {
		await axios.post(url, payload, { headers });
	} catch (error: any) {
		if (error.response) {
			log.error("Error Response", error.response.data);
		} else {
			log.error("Error", error.message);
		}
	}
};

export const updateCometChatUser = async (userId: string, profile: string) => {
	const bucketUrl = `https://storage.googleapis.com/${USER_PROFILES_BUCKET}`;

	const avatar = bucketUrl + `/${profile}`;

	const url = `${COMET_CHAT_BASE_URL}/users/${userId}`;
	const options = {
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			apiKey,
		},
	};

	try {
		await axios.put(
			url,
			{
				avatar,
			},
			options,
		);
	} catch (error: any) {
		if (error.response) {
			log.error("Error Response", error.response.data);
		} else {
			log.error("Error", error.message);
		}
	}
};
