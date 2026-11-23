import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { CorsError } from "../config/corsOptions";
import { MAX_UPLOAD_BYTES, UploadRejectedError } from "./uploads";
import log, { coarseRoute } from "../lib/logger";

/**
 * Last-resort handler. Express recognises an error handler only by its four parameters. Known client errors get a
 * specific status and message; anything else is logged (with its stack, on the server only) and answered with a
 * generic 500 that reveals no internals. Every JSON error body also carries `requestId` (added by requestContext).
 */
export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
	if (res.headersSent) return next(err);

	if (err?.type === "entity.parse.failed") return res.status(400).json({ message: "Malformed JSON body." });
	if (err?.type === "entity.too.large") return res.status(413).json({ message: "Request body is too large." });
	if (err instanceof CorsError) return res.status(403).json({ message: "Origin not allowed." });
	if (err instanceof UploadRejectedError) return res.status(400).json({ message: err.message });
	if (err instanceof multer.MulterError) {
		if (err.code === "LIMIT_FILE_SIZE") {
			return res
				.status(413)
				.json({ message: `Each file must be under ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.` });
		}
		return res.status(400).json({ message: "Invalid file upload." });
	}

	log.error("exception", `Unhandled error on ${req.method} ${req.context?.route ?? coarseRoute(req.path)}`, err);
	res.status(500).json({ message: "Internal Server Error", requestId: req.context?.requestId });
};
