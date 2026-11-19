import { body } from "express-validator";
import { MAX_TEXT_LENGTH } from "./common.validators";

export const NAME_REGEX = /^[a-zA-Z\xC0-\uFFFF]+([ \-']{0,1}[a-zA-Z\xC0-\uFFFF]+){0,2}[.]{0,1}$/;
export const EMAIL_REGEX =
	/(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])/;

export const validateLoginFields = [
	body("email").isEmail().matches(EMAIL_REGEX).withMessage("Invalid email address").isLength({ max: 255 }),
	body("password").isString().notEmpty().isLength({ max: 255 }).withMessage("Invalid password"),
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

/** The password policy for users, also used for admin passwords. */
export const strongPassword = (field: string) =>
	body(field)
		.isString()
		.withMessage("Password must be text.")
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
		.withMessage("Password must contain at least one special character");

export const validateResetPasswordFields = [
	body("token").isString().notEmpty().isLength({ max: 2048 }).withMessage("Token is required"),
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

export const validateUpdateProfileFields = [
	body("firstName")
		.optional({ values: "falsy" })
		.isLength({ min: 2, max: 50 })
		.matches(NAME_REGEX)
		.withMessage("First name must be 2-50 characters and valid."),
	body("lastName")
		.optional({ values: "falsy" })
		.isLength({ min: 2, max: 50 })
		.matches(NAME_REGEX)
		.withMessage("Last name must be 2-50 characters and valid."),
	body("phone")
		.optional({ values: "falsy" })
		.isString()
		.withMessage("Phone number must be a string.")
		.isLength({ max: MAX_TEXT_LENGTH })
		.withMessage("Phone number must be at most 200 characters."),
	body("country")
		.optional({ values: "falsy" })
		.isString()
		.withMessage("Country must be a string.")
		.isLength({ max: MAX_TEXT_LENGTH })
		.withMessage("Country must be at most 200 characters."),
	body("state")
		.optional({ values: "falsy" })
		.isString()
		.withMessage("State must be a string.")
		.isLength({ max: MAX_TEXT_LENGTH })
		.withMessage("State must be at most 200 characters."),
	body("city")
		.optional({ values: "falsy" })
		.isString()
		.withMessage("City must be a string.")
		.isLength({ max: MAX_TEXT_LENGTH })
		.withMessage("City must be at most 200 characters."),
	body("street")
		.optional({ values: "falsy" })
		.isString()
		.withMessage("Street must be a string.")
		.isLength({ max: MAX_TEXT_LENGTH })
		.withMessage("Street must be at most 200 characters."),
];
