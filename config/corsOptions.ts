import { isAllowedOrigin } from "./allowedOrigins";
import { CorsOptions } from "cors";

const corsOptions: CorsOptions = {
	origin: (origin: string | undefined, callback: any) => {
		if (isAllowedOrigin(origin)) {
			callback(null, true);
		} else {
			console.warn(`Blocked by CORS: ${origin}`);
			callback(new Error("Not allowed by CORS"));
		}
	},
	credentials: true,
	methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
	optionsSuccessStatus: 204,
};

export default corsOptions;
