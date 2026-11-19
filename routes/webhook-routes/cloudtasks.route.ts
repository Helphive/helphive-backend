import express, { NextFunction, Request, Response } from "express";

import {
	handleGoogleCloudTasksChatWindow,
	handleGoogleCloudTasksBookingExpired,
	handleGoogleCloudTasksEarningComplete,
} from "../../controllers/webhook-controllers/cloudtasks.controller";
import { safeEqual } from "../../controllers/user-controllers/utils/token.utils";
import { webhookLimiter } from "../../middleware/rateLimit";
import { recordTaskRun } from "../../lib/webhookRecorder";
import log from "../../lib/logger";

const cloudTasksRoute = express.Router();

// A short or missing secret would be guessable; refuse every call until a proper one is configured.
const MIN_SECRET_LENGTH = 16;

/**
 * Tasks are created by this server with a shared bearer secret (see createGoogleCloudTask* in the utils). Anyone who
 * learns the secret could trigger payouts and expiries, so it is compared in constant time and never logged.
 */
const verifyHeader = (req: Request, res: Response, next: NextFunction) => {
	const secret = process.env.GOOGLE_CLOUD_TASKS_SECRET || "";
	if (secret.length < MIN_SECRET_LENGTH) {
		log.error("GOOGLE_CLOUD_TASKS_SECRET is missing or too short; refusing Cloud Tasks calls.");
		return res.status(401).json({ message: "Unauthorized" });
	}
	const header = req.headers.authorization;
	const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
	if (!presented || !safeEqual(presented, secret)) {
		return res.status(401).json({ message: "Unauthorized" });
	}
	next();
};

const tasksLimiter = webhookLimiter("cloud-tasks-rejected", 401);

// Every call is recorded in taskruns (including refused ones), before the limiter so a 429 is recorded too.
cloudTasksRoute.post(
	"/earning-complete",
	recordTaskRun("earning-complete"),
	tasksLimiter,
	verifyHeader,
	handleGoogleCloudTasksEarningComplete,
);
cloudTasksRoute.post(
	"/booking-expired",
	recordTaskRun("booking-expired"),
	tasksLimiter,
	verifyHeader,
	handleGoogleCloudTasksBookingExpired,
);

// Re-checks whether a booking's customer and provider may still chat (scheduled for the end of a grace period).
cloudTasksRoute.post(
	"/chat-window",
	recordTaskRun("chat-window"),
	tasksLimiter,
	verifyHeader,
	handleGoogleCloudTasksChatWindow,
);

export default cloudTasksRoute;
