import express from "express";
import stripeRoute from "./stripe.route";
import cloudTasksRoute from "./cloudtasks.route";
import cometChatRoute from "./cometchat.route";
import { rejectOperatorKeys } from "../../middleware/sanitizeInput";
import { bindRequestContext } from "../../middleware/requestContext";

const webhookRoute = express.Router();

// Stripe needs the raw body to check its signature; Stripe events are well under 1 MB.
webhookRoute.use("/stripe", express.raw({ type: "application/json", limit: "1mb" }), bindRequestContext, stripeRoute);
webhookRoute.use(
	"/google-cloud-tasks",
	express.json({ limit: "10kb" }),
	bindRequestContext,
	rejectOperatorKeys,
	cloudTasksRoute,
);

// CometChat message payloads are small; media is uploaded to CometChat, never here.
webhookRoute.use("/cometchat", express.json({ limit: "256kb" }), bindRequestContext, cometChatRoute);

export default webhookRoute;
