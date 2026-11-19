import { Request, Response, NextFunction } from "express";

import { originAllowedFor } from "../config/corsOptions";

export const credentials = (req: Request, res: Response, next: NextFunction) => {
	const origin = req.headers.origin;
	if (origin && originAllowedFor(req.path, origin)) {
		res.header("Access-Control-Allow-Credentials", "true");
	}
	next();
};
