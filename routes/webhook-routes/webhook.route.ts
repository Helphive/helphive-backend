import express from "express";
import stripeRoute from "./stripe.route";
import cloudTasksRoute from "./cloudtasks.route";

const webhookRoute = express.Router();

webhookRoute.use("/stripe", express.raw({ type: "application/json" }), stripeRoute);
webhookRoute.use("/google-cloud-tasks", express.json(), cloudTasksRoute);

export default webhookRoute;
