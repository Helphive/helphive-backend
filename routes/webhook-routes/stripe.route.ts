import express from "express";

import { handleStripeWebhook } from "../../controllers/webhook-controllers/stripe.controller";

const stripeRoute = express.Router();

stripeRoute.post("/", handleStripeWebhook);

export default stripeRoute;
