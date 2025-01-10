import axios from "axios";
import { COMET_CHAT_BASE_URL } from "../../../config/config";

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
		const response = await axios.post(
			url,
			{
				metadata: { "@private": { email } },
				uid: userId,
				name,
			},
			options,
		);
		console.log(response.data);
	} catch (error: any) {
		console.error(error.response.data.error.details);
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
