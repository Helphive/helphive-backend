import { CloudTasksClient } from "@google-cloud/tasks";
import { GOOGLE_CLOUD_PROJECT_ID } from "../../config/config";

// Application Default Credentials (the Cloud Run service account; `gcloud auth application-default login` locally).
export const googleCloudTasks = new CloudTasksClient({ projectId: GOOGLE_CLOUD_PROJECT_ID });
