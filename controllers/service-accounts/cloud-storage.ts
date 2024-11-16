import { Storage } from "@google-cloud/storage";
import path from "path";

const storageOptions =
	process.env.NODE_ENV === "development"
		? {
				keyFilename: path.join(process.env.GOOGLE_CLOUD_STORAGE_SERVICE_ACCOUNT || ""),
			}
		: {};

export const googleStorage = new Storage(storageOptions);

export const providerAccountBucket = process.env.PROVIDER_ACCOUNT_BUCKET || "";
export const userProfilesBucket = process.env.USER_PROFILES_BUCKET || "";
