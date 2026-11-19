// CometChat webhook, mounted at /webhook/cometchat with its own JSON parser. Authentication is HTTP Basic auth with
// COMETCHAT_WEBHOOK_USERNAME / COMETCHAT_WEBHOOK_PASSWORD (the credentials set on the webhook in the CometChat
// dashboard). Until both are set (password at least 24 characters) every call is refused with 503.
import express, { NextFunction, Request, Response } from "express";
import { chatConfig } from "../../config/chat";
import { verifyBasicAuth } from "../../lib/chat/chatRules";
import { webhookLimiter } from "../../middleware/rateLimit";
import { handleCometChatWebhook } from "../../controllers/webhook-controllers/cometchat.controller";
import log from "../../lib/logger";

const cometChatRoute = express.Router();

export const verifyCometChatWebhook = (req: Request, res: Response, next: NextFunction) => {
	const { webhook } = chatConfig();
	if (!webhook.configured) {
		log.error("COMETCHAT_WEBHOOK_USERNAME / COMETCHAT_WEBHOOK_PASSWORD are not set; refusing CometChat webhooks.");
		return res.status(503).json({ message: "Webhook not configured" });
	}
	if (!verifyBasicAuth(req.headers.authorization, webhook.username, webhook.password)) {
		return res.status(401).json({ message: "Unauthorized" });
	}
	next();
};

/** The body must be a JSON object with a trigger; anything else is refused before any work. */
export const validateCometChatPayload = (req: Request, res: Response, next: NextFunction) => {
	if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || typeof req.body.trigger !== "string") {
		return res.status(400).json({ message: "Invalid payload" });
	}
	if (req.body.trigger.length > 64) return res.status(400).json({ message: "Invalid payload" });
	next();
};

// Only rejected (401) calls count against the limiter, so CometChat's own deliveries are never limited.
export const cometChatWebhookLimiter = webhookLimiter("cometchat-rejected", 401);

cometChatRoute.post(
	"/",
	cometChatWebhookLimiter,
	verifyCometChatWebhook,
	validateCometChatPayload,
	handleCometChatWebhook,
);

export default cometChatRoute;
