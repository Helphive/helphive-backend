import axios from "axios";

const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID;
const ONE_SIGNAL_REST_API_KEY = process.env.ONE_SIGNAL_REST_API_KEY;

export const oneSignalApi = axios.create({
	baseURL: "https://api.onesignal.com/",
	headers: {
		"Content-Type": "application/json",
		Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}`,
	},
});

export const sendNotification = async (data: any) => {
	try {
		const response = await oneSignalApi.post("/notifications", {
			app_id: ONE_SIGNAL_APP_ID,
			target_channel: "push",
			...data,
		});
		return response.data;
	} catch (error) {
		console.error("Error sending notification");
		throw error;
	}
};
