import express from "express";
import stripeRoute from "./stripe.route";
import cloudTasksRoute from "./cloudtasks.route";
import { rejectOperatorKeys } from "../../middleware/sanitizeInput";

const webhookRoute = express.Router();

// Stripe needs the raw body to check its signature; Stripe events are well under 1 MB.
webhookRoute.use("/stripe", express.raw({ type: "application/json", limit: "1mb" }), stripeRoute);
webhookRoute.use("/google-cloud-tasks", express.json({ limit: "10kb" }), rejectOperatorKeys, cloudTasksRoute);

export default webhookRoute;
