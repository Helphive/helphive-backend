import { Request, Response, NextFunction } from "express";
import { DEMO_ACCOUNT_BLOCKED_MESSAGE, isDemoAccountEmail } from "../config/demoAccounts";

// Runs after verifyJWT, which sets req.user to the signed-in email.
export const blockDemoAccounts = (req: Request, res: Response, next: NextFunction) => {
	if (isDemoAccountEmail(req.user)) {
		return res.status(403).json({ message: DEMO_ACCOUNT_BLOCKED_MESSAGE });
	}
	next();
};
