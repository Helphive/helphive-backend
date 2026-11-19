import { NextFunction, Request, Response } from "express";
import { body, validationResult } from "express-validator";
import { isValidObjectId } from "../utils/booking.utils";

/** Ends a validator chain: answers 400 with the first message instead of reaching the handler. */
export const rejectIfInvalid = (req: Request, res: Response, next: NextFunction) => {
	const errors = validationResult(req);
	if (!errors.isEmpty()) return res.status(400).json({ message: errors.array()[0].msg });
	next();
};

export const bookingIdInBody = body("bookingId")
	.custom((value) => isValidObjectId(value))
	.withMessage("Invalid booking id.");

// Free-text profile and address fields: strings of a sane length, never objects.
export const MAX_TEXT_LENGTH = 200;
export const MAX_ADDRESS_LENGTH = 500;

/** For routes that take no input: refuses any query parameter or body field, so the route has a declared shape. */
export const validateNoInput = (req: Request, res: Response, next: NextFunction) => {
	const query = Object.keys(req.query ?? {});
	const bodyKeys = req.body && typeof req.body === "object" ? Object.keys(req.body) : [];
	if (query.length || bodyKeys.length) {
		return res.status(400).json({ message: "This endpoint takes no parameters." });
	}
	next();
};
