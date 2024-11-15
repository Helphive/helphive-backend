import express from "express";
import { handleStripeWebhook } from "../controllers/webhook.controller";

const webhookRoute = express.Router();

webhookRoute.post("/stripe", handleStripeWebhook);

export default webhookRoute;
