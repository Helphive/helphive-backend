import { Storage } from "@google-cloud/storage";
import path from "path";

export const googleStorage = new Storage({
	keyFilename: path.join(process.env.GOOGLE_CLOUD_STORAGE_SERVICE_ACCOUNT || ""),
});

export const providerAccountBucket = process.env.PROVIDER_ACCOUNT_BUCKET || "";
export const userProfilesBucket = process.env.USER_PROFILES_BUCKET || "";
