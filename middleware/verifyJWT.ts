import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../controllers/user-controllers/utils/token.utils";
import { setActor } from "../lib/requestContext";
import log from "../lib/logger";

declare module "express" {
	interface Request {
		user?: string;
		roles?: { User: boolean; Provider: boolean };
		providerStatus?: string;
		/** The session of the access token (chat tokens are issued per session). */
		sessionId?: string;
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
		req.sessionId = result.sessionId;
		setActor(result.user.roles?.Provider ? "provider" : "user", String(result.user._id), req.context);
		next();
	} catch (err) {
		log.error("verifying_token_failed", "Error verifying token", err);
		return res.status(500).send({ error: "Internal Server Error" });
	}
};
