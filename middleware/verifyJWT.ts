import { Request, Response, NextFunction } from "express";
import jwt, { VerifyErrors } from "jsonwebtoken";
import UserModel from "../dal/models/user.model";

const accessTokenKey = process.env.ACCESS_TOKEN_SECRET || "";

declare module "express" {
	interface Request {
		user?: string;
		roles?: { User: boolean; Provider: boolean };
	}
}

interface DecodedInfo {
	UserInfo: {
		email: string;
		roles: { User: boolean; Provider: boolean };
		sessionId: string;
	};
}

export const verifyJWT = async (req: Request, res: Response, next: NextFunction) => {
	const authHeader = req.headers.authorization;
	if (!authHeader?.startsWith("Bearer ")) return res.status(401).send({ error: "Unauthorized Access." });
	const token = authHeader?.split(" ")[1];

	jwt.verify(token, accessTokenKey, async (error: VerifyErrors | null, decoded: unknown) => {
		if (error) return res.status(403).send({ error: "Access forbidden!" });

		const decodedInfo = decoded as DecodedInfo | undefined;
		const userEmail = decodedInfo?.UserInfo.email;
		const sessionId = decodedInfo?.UserInfo.sessionId;

		if (userEmail && sessionId) {
			try {
				const user = await UserModel.findOne({ email: userEmail });
				if (!user || user.sessionId !== sessionId) {
					return res.status(403).send({ error: "Access forbidden!" });
				}
				req.user = userEmail;
				req.roles = user.roles;
				next();
			} catch (err) {
				console.error("Error verifying token:", err);
				return res.status(500).send({ error: "Internal Server Error" });
			}
		} else {
			return res.status(403).send({ error: "Access forbidden!" });
		}
	});
};
