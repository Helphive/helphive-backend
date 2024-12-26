import { CloudTasksClient } from "@google-cloud/tasks";
import { GOOGLE_CLOUD_PROJECT_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL } from "../../config";

const cloudTasksConfig = {
	projectId: GOOGLE_CLOUD_PROJECT_ID,
	credentials: {
		client_email: GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL,
		private_key: process.env.GOOGLE_CLOUD_KEY?.replace(/\\n/g, "\n"),
	},
};

export const googleTasks = new CloudTasksClient(cloudTasksConfig);
