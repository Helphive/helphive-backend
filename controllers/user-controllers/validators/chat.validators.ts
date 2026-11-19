import { body, param } from "express-validator";
import { isValidObjectId } from "../utils/booking.utils";
import { rejectIfInvalid } from "./common.validators";
import { REPORT_CATEGORIES } from "../../../lib/chat/chatRules";

const uid = (field: ReturnType<typeof body>) =>
	field.custom((value) => isValidObjectId(value)).withMessage("Invalid user id.");

export const validateBookingConversation = [
	param("bookingId")
		.custom((value) => isValidObjectId(value))
		.withMessage("Invalid booking id."),
	rejectIfInvalid,
];

export const validateCreateReport = [
	uid(body("reportedUid")),
	body("category")
		.isIn(REPORT_CATEGORIES)
		.withMessage(`category must be one of ${REPORT_CATEGORIES.join(", ")}.`),
	body("details")
		.optional({ values: "null" })
		.isString()
		.withMessage("details must be text.")
		.bail()
		.trim()
		.isLength({ max: 1000 })
		.withMessage("details must be at most 1000 characters."),
	body("messageId")
		.optional({ values: "null" })
		.custom(
			(value) =>
				(typeof value === "string" || typeof value === "number") && /^[0-9A-Za-z_-]{1,64}$/.test(String(value)),
		)
		.withMessage("Invalid message id.")
		.customSanitizer((value) => String(value)),
	rejectIfInvalid,
];

export const validateViewing = [
	body("withUid")
		.custom((value) => value === null || isValidObjectId(value))
		.withMessage("withUid must be a user id or null."),
	rejectIfInvalid,
];

export const validateBlock = [uid(body("uid")), rejectIfInvalid];

export const validateUnblock = [
	param("uid")
		.custom((value) => isValidObjectId(value))
		.withMessage("Invalid user id."),
	rejectIfInvalid,
];
