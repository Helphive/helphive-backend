import { isAllowedOrigin } from "./allowedOrigins";
import { CorsOptions } from "cors";

export class CorsError extends Error {}

const corsOptions: CorsOptions = {
	origin: (origin: string | undefined, callback: any) => {
		if (isAllowedOrigin(origin)) {
			callback(null, true);
		} else {
			console.warn(`Blocked by CORS: ${origin}`);
			callback(new CorsError("Not allowed by CORS"));
		}
	},
	credentials: true,
	methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
	// Lets browser clients read when to retry after a 429.
	exposedHeaders: ["Retry-After", "RateLimit", "RateLimit-Policy"],
	optionsSuccessStatus: 204,
};

export default corsOptions;
