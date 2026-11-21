import { Storage } from "@google-cloud/storage";
import { PROVIDER_ACCOUNT_BUCKET, USER_PROFILES_BUCKET, GOOGLE_CLOUD_PROJECT_ID } from "../../config/config";

// Application Default Credentials: the Cloud Run service account in production (signed URLs go through the IAM
// signBlob API, so that account holds Service Account Token Creator on itself); `gcloud auth application-default
// login` locally. No key file.
export const googleCloudStorage = new Storage({ projectId: GOOGLE_CLOUD_PROJECT_ID });

export const providerAccountBucket = PROVIDER_ACCOUNT_BUCKET;
export const userProfilesBucket = USER_PROFILES_BUCKET;
