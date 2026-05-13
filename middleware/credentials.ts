import { Request, Response, NextFunction } from "express";

import { isAllowedOrigin } from "../config/allowedOrigins";

export const credentials = (req: Request, res: Response, next: NextFunction) => {
	const origin = req.headers.origin;
	if (origin && isAllowedOrigin(origin)) {
		res.header("Access-Control-Allow-Credentials", "true");
	}
	next();
};
