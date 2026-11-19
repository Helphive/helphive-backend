import { body, param } from "express-validator";
import { isValidObjectId } from "../utils/booking.utils";
import { rejectIfInvalid } from "./common.validators";
import { EMAIL_REGEX, NAME_REGEX, strongPassword } from "./auth.validators";
import { ADMIN_ROLES } from "../../../config/adminPermissions";

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

const code = (field: string) =>
	body(field)
		.optional({ values: "falsy" })
		.isString()
		.withMessage("The code must be text.")
		.isLength({ max: 64 })
		.withMessage("The code is too long.");

/** A six-digit code or a recovery code; at least one. */
export const validateSecondFactor = [
	code("code"),
	code("recoveryCode"),
	body()
		.custom((value) => !!(value?.code || value?.recoveryCode))
		.withMessage("Enter a code or a recovery code."),
	rejectIfInvalid,
];

export const validateTotpCode = [
	body("code")
		.isString()
		.withMessage("Enter the six-digit code.")
		.matches(/^\s*\d{3}\s?\d{3}\s*$/)
		.withMessage("Enter the six-digit code."),
	rejectIfInvalid,
];

export const validateLoginMfa = [
	body("challengeToken")
		.isString()
		.withMessage("The sign-in step has expired. Sign in again.")
		.isLength({ max: 2048 })
		.withMessage("The sign-in step has expired. Sign in again."),
	...validateSecondFactor,
];

export const validateChangePassword = [
	body("currentPassword")
		.isString()
		.withMessage("Enter your current password.")
		.notEmpty()
		.withMessage("Enter your current password.")
		.isLength({ max: 255 })
		.withMessage("Enter your current password."),
	strongPassword("newPassword"),
	rejectIfInvalid,
];

export const adminIdParam = [
	param("id")
		.custom((value) => isValidObjectId(value))
		.withMessage("Invalid admin id."),
	rejectIfInvalid,
];

export const sessionIdParam = [
	param("id")
		.custom((value) => isValidObjectId(value))
		.withMessage("Invalid session id."),
	rejectIfInvalid,
];

export const auditIdParam = [
	param("id")
		.custom((value) => isValidObjectId(value))
		.withMessage("Invalid entry id."),
	rejectIfInvalid,
];

const reason = (required: boolean) => {
	const chain = body("reason");
	return (required ? chain : chain.optional({ values: "falsy" }))
		.isString()
		.withMessage("Reason must be text.")
		.trim()
		.isLength({ min: required ? 3 : 0, max: 1000 })
		.withMessage(required ? "Give a reason (3 to 1000 characters)." : "Reason must be at most 1000 characters.");
};

export const validateOptionalReason = [reason(false), rejectIfInvalid];
export const validateRequiredReason = [reason(true), rejectIfInvalid];

export const validateCreateAdmin = [
	body("firstName")
		.isString()
		.trim()
		.isLength({ min: 2, max: 50 })
		.matches(NAME_REGEX)
		.withMessage("First name is required, must be 2-50 characters, and valid."),
	body("lastName")
		.isString()
		.trim()
		.isLength({ min: 2, max: 50 })
		.matches(NAME_REGEX)
		.withMessage("Last name is required, must be 2-50 characters, and valid."),
	body("email")
		.isString()
		.trim()
		.isEmail()
		.matches(EMAIL_REGEX)
		.isLength({ max: 255 })
		.withMessage("Invalid email address"),
	body("role")
		.isIn(ADMIN_ROLES)
		.withMessage(`Role must be one of: ${ADMIN_ROLES.join(", ")}.`),
	rejectIfInvalid,
];

export const validateRoleChange = [
	body("role")
		.isIn(ADMIN_ROLES)
		.withMessage(`Role must be one of: ${ADMIN_ROLES.join(", ")}.`),
	reason(false),
	rejectIfInvalid,
];
