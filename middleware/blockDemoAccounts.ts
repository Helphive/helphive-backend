import { Request, Response, NextFunction } from "express";
import { DEMO_ACCOUNT_BLOCKED_MESSAGE, isDemoAccountEmail } from "../config/demoAccounts";
import { emitEvent } from "../lib/events";

// Runs after verifyJWT, which sets req.user to the signed-in email.
export const blockDemoAccounts = (req: Request, res: Response, next: NextFunction) => {
	if (isDemoAccountEmail(req.user)) {
		const actor = req.context?.actor;
		emitEvent(
			{
				type: "security.demo_account_blocked",
				subjects: actor ? { userId: actor.id } : {},
				properties: { action: `${req.method} ${req.baseUrl}${req.path}` },
			},
			req,
		);
		return res.status(403).json({ message: DEMO_ACCOUNT_BLOCKED_MESSAGE });
	}
	next();
};
