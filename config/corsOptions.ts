import allowedOrigins from "./allowedOrigins";
import { CorsOptions } from "cors";

const corsOptions: CorsOptions = {
	origin: (origin: string | undefined, callback: any) => {
		if (
			!origin ||
			allowedOrigins.some((pattern) => (typeof pattern === "string" ? pattern === origin : pattern.test(origin)))
		) {
			callback(null, true);
		} else {
			console.log(origin);
			callback(new Error("Not allowed by CORS"));
		}
	},
	optionsSuccessStatus: 200,
};

export default corsOptions;
