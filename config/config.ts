const NODE_ENV = (process.env.NODE_ENV || "development") as "development" | "production";

type Config = {
	development: { CLIENT_BASE_URL: string; SERVER_BASE_URL: string };
	production: { CLIENT_BASE_URL: string; SERVER_BASE_URL: string };
	common: {
		VERIFICATION_EMAIL: string;
		SUPPORT_EMAIL: string;
		PROVIDER_ACCOUNT_BUCKET: string;
		USER_PROFILES_BUCKET: string;
		PUBLIC_BUCKET: string;
		GOOGLE_CLOUD_PROJECT_ID: string;
		GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL: string;
		GOOGLE_CLOUD_TASKS_QUEUE_PATH: string;
		AZURE_OPENAI_BASE_URL: string;
		AZURE_OPENAI_API_VERSION: string;
		AZURE_OPENAI_DEPLOYMENT: string;
		COMET_CHAT_BASE_URL: string;
	};
};

const config: Config = {
	development: {
		CLIENT_BASE_URL: `https://ram-strong-cat.ngrok-free.app`,
		SERVER_BASE_URL: `https://ram-strong-cat.ngrok-free.app`,
	},
	production: {
		CLIENT_BASE_URL: "https://api.helphivenow.com",
		SERVER_BASE_URL: "https://api.helphivenow.com",
	},
	common: {
		VERIFICATION_EMAIL: "verify@helphivenow.com",
		SUPPORT_EMAIL: "support@helphivenow.com",
		PROVIDER_ACCOUNT_BUCKET: "helphive-provider-applications",
		USER_PROFILES_BUCKET: "helphive-users",
		PUBLIC_BUCKET: "helphive-public",
		GOOGLE_CLOUD_PROJECT_ID: "helphive",
		GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL: "helphive-backend-server@helphive.iam.gserviceaccount.com",
		GOOGLE_CLOUD_TASKS_QUEUE_PATH: "projects/helphive/locations/us-central1/queues/helphive-app-queue",
		AZURE_OPENAI_BASE_URL:
			"https://maizazureopenai.openai.azure.com/openai/deployments/gpt-4o-helphive/chat/completions?api-version=2024-08-01-preview",
		AZURE_OPENAI_API_VERSION: "2024-08-01-preview",
		AZURE_OPENAI_DEPLOYMENT: "gpt-4o-helphive",
		COMET_CHAT_BASE_URL: "https://26925431c1f0b1aa.api-eu.cometchat.io/v3",
	},
};

export const { CLIENT_BASE_URL, SERVER_BASE_URL } = config[NODE_ENV];
export const {
	VERIFICATION_EMAIL,
	SUPPORT_EMAIL,
	PROVIDER_ACCOUNT_BUCKET,
	USER_PROFILES_BUCKET,
	PUBLIC_BUCKET,
	GOOGLE_CLOUD_PROJECT_ID,
	GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL,
	GOOGLE_CLOUD_TASKS_QUEUE_PATH,
	AZURE_OPENAI_BASE_URL,
	AZURE_OPENAI_API_VERSION,
	AZURE_OPENAI_DEPLOYMENT,
	COMET_CHAT_BASE_URL,
} = config.common;
