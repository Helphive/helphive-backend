const NODE_ENV = (process.env.NODE_ENV || "development") as "development" | "production";
const PORT = process.env.PORT || 8080;

type Config = {
	development: { CLIENT_BASE_URL: string; SERVER_BASE_URL: string };
	production: { CLIENT_BASE_URL: string; SERVER_BASE_URL: string };
	common: {
		VERIFICATION_EMAIL: string;
		PROVIDER_ACCOUNT_BUCKET: string;
		USER_PROFILES_BUCKET: string;
		GOOGLE_CLOUD_PROJECT_ID: string;
		GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL: string;
	};
};

const config: Config = {
	development: {
		CLIENT_BASE_URL: `http://localhost:${PORT}`,
		SERVER_BASE_URL: `http://localhost:${PORT}`,
	},
	production: {
		CLIENT_BASE_URL: "https://api.helphivenow.com",
		SERVER_BASE_URL: "https://api.helphivenow.com",
	},
	common: {
		VERIFICATION_EMAIL: "verify@helphivenow.com",
		PROVIDER_ACCOUNT_BUCKET: "helphive-provider-applications",
		USER_PROFILES_BUCKET: "helphive-users",
		GOOGLE_CLOUD_PROJECT_ID: "helphive",
		GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL: "helphive-backend-server@helphive.iam.gserviceaccount.com",
	},
};

export const { CLIENT_BASE_URL, SERVER_BASE_URL } = config[NODE_ENV];
export const {
	VERIFICATION_EMAIL,
	PROVIDER_ACCOUNT_BUCKET,
	USER_PROFILES_BUCKET,
	GOOGLE_CLOUD_PROJECT_ID,
	GOOGLE_CLOUD_SERVICE_ACCOUNT_CLIENT_EMAIL,
} = config.common;