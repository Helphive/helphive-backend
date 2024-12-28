import { CloudTasksClient } from "@google-cloud/tasks";
import { GOOGLE_CLOUD_PROJECT_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL } from "../../config/config";

const cloudTasksConfig = {
	projectId: GOOGLE_CLOUD_PROJECT_ID,
	credentials: {
		client_email: GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL,
		private_key: process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
	},
};

export const googleCloudTasks = new CloudTasksClient(cloudTasksConfig);
