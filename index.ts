import express, { Request, Response } from "express";
import path from "path";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import connectDB from "./config/dbConn";
import corsOptions from "./config/corsOptions";

import { logger } from "./middleware/logEvents";
import { credentials } from "./middleware/credentials";
import { errorHandler } from "./middleware/errorHandler";

dotenv.config();

import authRoute from "./routes/auth.route";
import adminRoute from "./routes/admin.route";
import emailRoute from "./routes/email.route";
import webhookRoute from "./routes/webhook.route";
import { Server, WebSocket as WS } from "ws";
import { handleProviderAvailabilityWebSocket } from "./controllers/user-controllers/provider-websocket";

const app = express();
const PORT = process.env.PORT || 8080;

// Start the server first
const server = app.listen(PORT, () => {
	if (
		!process.env.PORT ||
		!process.env.NODE_ENV ||
		!process.env.CLIENT_BASE_URL ||
		!process.env.DATABASE_URI ||
		!process.env.ACCESS_TOKEN_SECRET ||
		!process.env.REFRESH_TOKEN_SECRET ||
		!process.env.EMAIL_VERIFICATION_SECRET ||
		!process.env.RESEND_API_KEY ||
		!process.env.RESEND_AUDIENCE_ID ||
		!process.env.VERIFICATION_EMAIL ||
		!process.env.PROVIDER_ACCOUNT_BUCKET ||
		!process.env.USER_PROFILES_BUCKET ||
		!process.env.GOOGLE_CLOUD_STORAGE_SERVICE_ACCOUNT ||
		!process.env.STRIPE_SECRET_KEY ||
		!process.env.STRIPE_WEBHOOK_SECRET ||
		!process.env.ONE_SIGNAL_APP_ID ||
		!process.env.ONE_SIGNAL_REST_API_KEY
	) {
		throw `Abort: You need to define variables in the .env file.`;
	}

	console.log(`Server is running on http://localhost:${PORT}`);
});

// Connect to MongoDB in parallel
connectDB();

app.use(logger);
app.use(credentials);
app.use(cors(corsOptions));
app.use(express.urlencoded({ extended: false }));

app.use("/webhook", express.raw({ type: "application/json" }), webhookRoute);

app.use(express.json());
app.use(cookieParser());

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req: Request, res: Response) => {
	res.sendFile(path.join(__dirname, "views", "Home", "home.html"));
});

app.use("/auth", authRoute);
app.use("/admin", adminRoute);
app.use("/email", emailRoute);

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
	console.log("Connected to MongoDB");
});

const wsServer = new Server({ server });
wsServer.on("listening", () => {
	console.log(`WebSocket server is listening on the same port as the HTTP server`);
});
wsServer.on("connection", (ws: WS, req: Request) => {
	console.log("Connection established.");
	const url = new URL(req.url || "", `http://localhost:8080`);
	const userEmail = url.searchParams.get("email");
	if (!userEmail) {
		ws.send(JSON.stringify({ error: "User email not found in URL parameters." }));
		ws.close();
		return;
	}
	console.log(url.pathname);
	if (url.pathname.startsWith("/provider-availability")) {
		handleProviderAvailabilityWebSocket(ws, userEmail);
	}
});
