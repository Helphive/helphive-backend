import { Storage } from "@google-cloud/storage";
import {
	PROVIDER_ACCOUNT_BUCKET,
	USER_PROFILES_BUCKET,
	GOOGLE_CLOUD_PROJECT_ID,
	GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL,
} from "../../config/config";

const storageOptions = {
	projectId: GOOGLE_CLOUD_PROJECT_ID,
	credentials: {
		client_email: GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL,
		private_key: process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
	},
};

export const googleCloudStorage = new Storage(storageOptions);

export const providerAccountBucket = PROVIDER_ACCOUNT_BUCKET;
export const userProfilesBucket = USER_PROFILES_BUCKET;
