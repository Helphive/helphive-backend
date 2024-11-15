import { body } from "express-validator";

const NAME_REGEX = /^[a-zA-Z\xC0-\uFFFF]+([ \-']{0,1}[a-zA-Z\xC0-\uFFFF]+){0,2}[.]{0,1}$/;
const EMAIL_REGEX =
	/(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])/;

export const validateLoginFields = [
	body("email").isEmail().matches(EMAIL_REGEX).withMessage("Invalid email address").isLength({ max: 255 }),
	body("password").notEmpty().withMessage("Invalid password"),
];

export const validateSignupFields = [
	body("firstName")
		.notEmpty()
		.isLength({ min: 2, max: 50 })
		.matches(NAME_REGEX)
		.withMessage("First name is required, must be 2-50 characters, and valid."),
	body("lastName")
		.notEmpty()
		.isLength({ min: 2, max: 50 })
		.matches(NAME_REGEX)
		.withMessage("Last name is required, must be 2-50 characters, and valid."),
	body("email").isEmail().matches(EMAIL_REGEX).withMessage("Invalid email address").isLength({ max: 255 }),
	body("password")
		.isLength({ min: 8, max: 255 })
		.withMessage(
			"Password must be at least 8 characters long, and contain at least one lowercase letter, one uppercase letter, one number, and one special character",
		)
		.matches(/[a-z]/)
		.withMessage("Password must contain at least one lowercase letter")
		.matches(/[A-Z]/)
		.withMessage("Password must contain at least one uppercase letter")
		.matches(/[0-9]/)
		.withMessage("Password must contain at least one number")
		.matches(/[^A-Za-z0-9]/)
		.withMessage("Password must contain at least one special character"),
];

export const validateResetPasswordFields = [
	body("token").notEmpty().withMessage("Token is required"),
	body("password")
		.isLength({ min: 8, max: 255 })
		.withMessage(
			"Password must be at least 8 characters long, and contain at least one lowercase letter, one uppercase letter, one number, and one special character",
		)
		.matches(/[a-z]/)
		.withMessage("Password must contain at least one lowercase letter")
		.matches(/[A-Z]/)
		.withMessage("Password must contain at least one uppercase letter")
		.matches(/[0-9]/)
		.withMessage("Password must contain at least one number")
		.matches(/[^A-Za-z0-9]/)
		.withMessage("Password must contain at least one special character"),
];
