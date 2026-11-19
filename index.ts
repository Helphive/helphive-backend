import express, { Request, Response } from "express";
import path from "path";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import mongoose from "mongoose";
import connectDB from "./config/dbConn";
import corsOptions from "./config/corsOptions";

import { SERVER_BASE_URL } from "./config/config";
import { requestContext, bindRequestContext } from "./middleware/requestContext";
import { credentials } from "./middleware/credentials";
import { configureIndexing, reportIndexBuilds } from "./config/indexes";
import { handleHealthz, handleReadyz } from "./controllers/health.controller";
import { warmEmailPolicy } from "./lib/emailPolicy";
import log from "./lib/logger";
import { errorHandler } from "./middleware/errorHandler";
import { globalLimiter } from "./middleware/rateLimit";
import { rejectOperatorKeys } from "./middleware/sanitizeInput";
import { observeRequests } from "./lib/observability/runtime";

dotenv.config();

import authRoute from "./routes/user-routes/auth.route";
import adminRoute from "./routes/admin.route";
import emailRoute from "./routes/email.route";
import webhookRoute from "./routes/webhook-routes/webhook.route";
import clientErrorsRoute from "./routes/clientErrors.route";
import { createProviderAvailabilityUpgradeHandler } from "./controllers/user-controllers/provider-websocket";

if (
	!process.env.PORT ||
	!process.env.NODE_ENV ||
	!process.env.DATABASE_URI ||
	!process.env.ACCESS_TOKEN_SECRET ||
	!process.env.REFRESH_TOKEN_SECRET ||
	!process.env.EMAIL_VERIFICATION_SECRET ||
	!process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_PRIVATE_KEY ||
	!process.env.RESEND_API_KEY ||
	!process.env.RESEND_AUDIENCE_ID ||
	!process.env.STRIPE_SECRET_KEY ||
	!process.env.STRIPE_WEBHOOK_SECRET ||
	!process.env.ONE_SIGNAL_APP_ID ||
	!process.env.ONE_SIGNAL_REST_API_KEY
) {
	throw `Abort: You need to define variables in the .env file.`;
}

for (const name of [
	"STRIPE_CONNECTED_WEBHOOK_SECRET",
	"GOOGLE_CLOUD_TASKS_SECRET",
	"ADMIN_ACCESS_TOKEN_SECRET",
	"ADMIN_MFA_ENCRYPTION_KEY",
]) {
	if (!process.env[name]) log.warn(`${name} is not set; see the notes in .env.example.`);
}

// Cloud Run sits behind one Google front end hop, which appends the real client address to X-Forwarded-For.
// Trusting exactly that hop makes req.ip the client and ignores whatever a client puts in the header itself.
const TRUST_PROXY_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "1", 10);
const trustProxyHops = Number.isInteger(TRUST_PROXY_HOPS) && TRUST_PROXY_HOPS >= 0 ? TRUST_PROXY_HOPS : 1;

const app = express();
const PORT = process.env.PORT || 8080;

app.set("trust proxy", trustProxyHops);
app.disable("x-powered-by");

const server = app.listen(PORT, () => {
	log.info(`Server is running at ${SERVER_BASE_URL}`);
});

configureIndexing();
connectDB();
// Load the disposable-domain list now rather than on the first sign-up.
warmEmailPolicy();

app.use(
	helmet({
		// The only HTML is the home, 404 and reset-password pages: same-origin scripts and styles plus Google Fonts.
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'"],
				// public/index.css imports Plus Jakarta Sans from Google Fonts.
				styleSrc: ["'self'", "https://fonts.googleapis.com"],
				fontSrc: ["'self'", "https://fonts.gstatic.com"],
				imgSrc: ["'self'", "data:"],
				connectSrc: ["'self'"],
				formAction: ["'self'"],
				frameAncestors: ["'none'"],
				objectSrc: ["'none'"],
				baseUri: ["'self'"],
			},
		},
		crossOriginResourcePolicy: { policy: "same-site" },
		// Reset-password links carry their token in the query string; never send it on as a referrer.
		referrerPolicy: { policy: "no-referrer" },
	}),
);
// Request id, client details and the access log come first, so every response (even an error) carries X-Request-Id.
app.use(requestContext);
// Request metrics and error tracking (lib/observability): counts each response when it finishes; never blocks.
app.use(observeRequests);
// Probes: no CORS, rate limit or body parsing, and logged only when they fail.
// Cloud Run's front end answers /healthz itself (404) and never passes it on, so /livez is the path that works there.
app.get("/healthz", handleHealthz);
app.get("/livez", handleHealthz);
app.get("/readyz", handleReadyz);
app.use(credentials);
app.use(cors(corsOptions));
app.use(globalLimiter);
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

app.use("/webhook", webhookRoute);
// Client error reports: own 16 KB body limit and rate limits (routes/clientErrors.route.ts).
app.use("/client-errors", clientErrorsRoute);

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
// Body parsers resume the chain from stream callbacks; re-enter the request context for everything after them.
app.use(bindRequestContext);
app.use(rejectOperatorKeys);

app.use(
	express.static(path.join(__dirname, "public"), {
		setHeaders: (res, filePath) => {
			if (filePath.endsWith("apple-app-site-association")) {
				res.setHeader("Content-Type", "application/json");
			}
		},
	}),
);

app.get("/", (req: Request, res: Response) => {
	res.sendFile(path.join(__dirname, "views", "Home", "home.html"));
});

app.use("/auth", authRoute);
app.use("/admin", adminRoute);
app.use("/email", emailRoute);

app.get("/stripe-onboarding", (req: Request, res: Response) => {
	// Back into the app after Stripe onboarding. Only the one known flag is passed on.
	const deepLink = `helphivenow://stripe-onboarding?refresh=${req.query.refresh === "true" ? "true" : "false"}`;
	res.redirect(deepLink);
});

app.all("*", (req: Request, res: Response) => {
	res.status(404);
	if (req.accepts("json")) {
		res.json({ error: "404 Not Found" });
	} else if (req.accepts("html")) {
		res.sendFile(path.join(__dirname, "views", "Not Found", "404.html"));
	} else {
		res.type("txt").send("404 Not Found");
	}
});

app.use(errorHandler);

mongoose.connection.once("open", () => {
	log.info("Connected to MongoDB");
	reportIndexBuilds();
});

server.on("upgrade", createProviderAvailabilityUpgradeHandler(trustProxyHops));
