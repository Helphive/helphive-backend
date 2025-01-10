import axios from "axios";
import { COMET_CHAT_BASE_URL } from "../../../config/config";
import { USER_PROFILES_BUCKET } from "../../../config/config";

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
			console.error("Error Response:", error.response.data);
		} else {
			console.error("Error:", error.message);
		}
	}
};

export const sendCometChatMessage = async (userId: string, friendId: string) => {
	const url = `${COMET_CHAT_BASE_URL}/messages`;
	const headers = {
		accept: "application/json",
		"content-type": "application/json",
		apikey: "d9911e858a3e0fc5620bc055d37351a9cb1df0ea",
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
			console.error("Error Response:", error.response.data);
		} else {
			console.error("Error:", error.message);
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
			console.error("Error Response:", error.response.data);
		} else {
			console.error("Error:", error.message);
		}
	}
};
