import express from "express";

import {
	handleStripeWebhook,
	handleStripeConnectedPayoutsWebhook,
} from "../../controllers/webhook-controllers/stripe.controller";

const stripeRoute = express.Router();

stripeRoute.post("/", handleStripeWebhook);
stripeRoute.post("/connected-payouts", handleStripeConnectedPayoutsWebhook);

export default stripeRoute;
