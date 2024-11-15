import { body } from "express-validator";

const NAME_REGEX = /^[a-zA-Z\xC0-\uFFFF]+([ \-']{0,1}[a-zA-Z\xC0-\uFFFF]+){0,2}[.]{0,1}$/;
const EMAIL_REGEX =
	/(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])/;

export const validateRequestProviderAccountFields = [
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
	body("phone").isString().notEmpty().withMessage("Phone number is required and must be a string."),
	body("country").isString().notEmpty().withMessage("Country is required and must be a string."),
	body("state").isString().notEmpty().withMessage("State is required and must be a string."),
	body("city").isString().notEmpty().withMessage("City is required and must be a string."),
	body("street").isString().notEmpty().withMessage("Street is required and must be a string."),
	body("id")
		.custom((value, { req }) => {
			if (!req.files || !req.files.id) {
				throw new Error("ID file is required");
			}
			return true;
		})
		.withMessage("ID file is required."),
	body("dbs")
		.custom((value, { req }) => {
			if (!req.files || !req.files.dbs) {
				throw new Error("DBS file is required");
			}
			return true;
		})
		.withMessage("DBS file is required."),
	body("resume")
		.custom((value, { req }) => {
			if (!req.files || !req.files.resume) {
				throw new Error("Resume file is required");
			}
			return true;
		})
		.withMessage("Resume file is required."),
	body("profile")
		.custom((value, { req }) => {
			if (!req.files || !req.files.profile) {
				throw new Error("Profile file is required");
			}
			return true;
		})
		.withMessage("Profile file is required."),
];

export const validateUpdateProviderAvailability = [
	body("isProviderAvailable")
		.exists()
		.withMessage("isProviderAvailable is required")
		.isBoolean()
		.withMessage("isProviderAvailable must be a boolean"),
	body("currentLocation")
		.exists()
		.withMessage("currentLocation is required")
		.isObject()
		.withMessage("currentLocation must be an object")
		.custom((value) => {
			if (!("latitude" in value) || !("longitude" in value)) {
				throw new Error("currentLocation must have latitude and longitude properties");
			}
			if (typeof value.latitude !== "number" || typeof value.longitude !== "number") {
				throw new Error("latitude and longitude must be numbers");
			}
			return true;
		}),
];
