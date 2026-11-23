import express from "express";

import {
	handleStripeWebhook,
	handleStripeConnectedPayoutsWebhook,
} from "../../controllers/webhook-controllers/stripe.controller";
import { webhookLimiter } from "../../middleware/rateLimit";
import { markRouteBase } from "../../middleware/requestContext";

const stripeRoute = express.Router();
stripeRoute.use(markRouteBase);

// Counts only calls rejected for a bad signature (400), so genuine Stripe deliveries are never limited.
const stripeLimiter = webhookLimiter("stripe-rejected", 400);

stripeRoute.post("/", stripeLimiter, handleStripeWebhook);
stripeRoute.post("/connected-payouts", stripeLimiter, handleStripeConnectedPayoutsWebhook);

export default stripeRoute;
