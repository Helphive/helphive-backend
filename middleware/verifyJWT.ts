import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../controllers/user-controllers/utils/token.utils";

declare module "express" {
	interface Request {
		user?: string;
		roles?: { User: boolean; Provider: boolean };
		providerStatus?: string;
	}
}

export const verifyJWT = async (req: Request, res: Response, next: NextFunction) => {
	const authHeader = req.headers.authorization;
	if (!authHeader?.startsWith("Bearer ")) return res.status(401).send({ error: "Unauthorized Access." });

	try {
		const result = await verifyAccessToken(authHeader.slice(7));
		// 403 (not 401) is what the shipped apps treat as "refresh and retry".
		if (!result.ok) return res.status(403).send({ error: "Access forbidden!" });
		req.user = result.email;
		req.roles = result.user.roles;
		req.providerStatus = result.user.providerStatus;
		next();
	} catch (err) {
		console.error("Error verifying token:", err);
		return res.status(500).send({ error: "Internal Server Error" });
	}
};
