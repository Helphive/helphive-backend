import { Request, Response, NextFunction } from "express";

/**
 * One line per request: method and path only. Query strings are left out because email-verification and
 * reset-password links carry their token there. Cloud Run collects stdout, so nothing is written to local files
 * (the container filesystem is held in memory and would grow without bound).
 */
export const logger = (req: Request, res: Response, next: NextFunction) => {
	console.log(`${req.method} ${req.path}`);
	next();
};
