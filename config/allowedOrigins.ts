const envOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const allowedOrigins: (string | RegExp)[] = [
	// Local web/admin development.
	/^http:\/\/localhost:\d+$/,
	/^http:\/\/127\.0\.0\.1:\d+$/,
	/^http:\/\/192\.168\.\d+\.\d+:\d+$/,
	/^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,
	/^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+:\d+$/,

	// Firebase preview channels.
	/^https:\/\/helphive--pr\d+-dev-cfzy9hyz\.web\.app$/,
	/^https:\/\/helphivenow--pr\d+-dev-cfzy9hyz\.web\.app$/,

	// Firebase hosting targets behind the Cloudflare custom domains.
	"https://helphive.web.app",
	"https://helphivenow.web.app",
	"https://helphive.firebaseapp.com",
	"https://helphivenow.firebaseapp.com",

	// Current public domains.
	"https://helphive.projects.himaiz.com",
	"https://admin.helphive.projects.himaiz.com",
	"https://api.helphive.projects.himaiz.com",

	...envOrigins,
];

export const isAllowedOrigin = (origin?: string): boolean => {
	if (!origin) return true;
	return allowedOrigins.some((pattern) => (typeof pattern === "string" ? pattern === origin : pattern.test(origin)));
};

export default allowedOrigins;
