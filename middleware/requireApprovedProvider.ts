import { Request, Response, NextFunction } from "express";

// Runs after verifyJWT and verifyRoles("Provider"). Open jobs, accepting and starting work, and availability are for
// providers an admin has approved; both apps only show those screens to approved providers.
export const requireApprovedProvider = (req: Request, res: Response, next: NextFunction) => {
	if (req.providerStatus !== "approved") {
		return res.status(403).json({ message: "Your provider account has not been approved yet." });
	}
	next();
};
