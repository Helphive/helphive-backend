import express, { NextFunction, Request, Response } from "express";

import { handleGoogleCloudTasksEarningComplete } from "../../controllers/webhook-controllers/cloudtasks.controller";

const cloudTasksRoute = express.Router();

const verifyHeader = (req: Request, res: Response, next: NextFunction) => {
	const authHeader = req.headers.authorization?.split(" ")[1];
	if (!authHeader || authHeader !== process.env.GOOGLE_CLOUD_TASKS_SECRET) {
		return res.status(401).json({ message: "Unauthorized" });
	}
	next();
};

cloudTasksRoute.post("/earning-complete", verifyHeader, handleGoogleCloudTasksEarningComplete);

export default cloudTasksRoute;
