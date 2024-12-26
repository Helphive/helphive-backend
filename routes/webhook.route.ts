import express from "express";
import { handleGoogleTasksPaymentTrigger, handleStripeWebhook } from "../controllers/webhook.controller";

const webhookRoute = express.Router();

webhookRoute.post("/stripe", handleStripeWebhook);
webhookRoute.post("/google-tasks/payment-trigger", handleGoogleTasksPaymentTrigger);

export default webhookRoute;
