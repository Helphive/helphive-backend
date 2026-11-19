import { body } from "express-validator";
import { isValidObjectId } from "../utils/booking.utils";
import { rejectIfInvalid } from "./common.validators";

export const PROVIDER_REVIEW_STATUSES = ["approved", "rejected"] as const;

export const validateUpdateProviderAccountRequestStatus = [
	body("providerAccountRequestId")
		.custom((value) => isValidObjectId(value))
		.withMessage("Invalid provider account request id."),
	body("status").isIn(PROVIDER_REVIEW_STATUSES).withMessage("Status must be approved or rejected."),
	body("message")
		.optional({ values: "null" })
		.isString()
		.withMessage("Message must be a string.")
		.isLength({ max: 1000 })
		.withMessage("Message must be at most 1000 characters."),
	rejectIfInvalid,
];
