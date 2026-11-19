import { lowerCaseEmail } from "./auth.validators";
import { body } from "express-validator";
import { MAX_TEXT_LENGTH, bookingIdInBody, rejectIfInvalid } from "./common.validators";

const NAME_REGEX = /^[a-zA-Z\xC0-￿]+([ \-']{0,1}[a-zA-Z\xC0-￿]+){0,2}[.]{0,1}$/;
const EMAIL_REGEX =
	/(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])/;

const requiredFile = (field: string, label: string) =>
	body(field)
		.custom((value, { req }) => {
			if (!req.files || !req.files[field]) {
				throw new Error(`${label} file is required`);
			}
			return true;
		})
		.withMessage(`${label} file is required.`);

const requiredText = (field: string, label: string) =>
	body(field)
		.isString()
		.notEmpty()
		.withMessage(`${label} is required and must be a string.`)
		.isLength({ max: MAX_TEXT_LENGTH })
		.withMessage(`${label} must be at most ${MAX_TEXT_LENGTH} characters.`);

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
	body("email")
		.customSanitizer(lowerCaseEmail)
		.isEmail()
		.matches(EMAIL_REGEX)
		.withMessage("Invalid email address")
		.isLength({ max: 255 }),
	requiredText("phone", "Phone number"),
	requiredText("country", "Country"),
	requiredText("state", "State"),
	requiredText("city", "City"),
	requiredText("street", "Street"),
	body("jobTypes").optional().isString().isLength({ max: 500 }).withMessage("jobTypes must be a JSON string."),
	requiredFile("id", "ID"),
	requiredFile("dbs", "DBS"),
	requiredFile("resume", "Resume"),
	requiredFile("profile", "Profile"),
];

const isLatitude = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
const isLongitude = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;

export const validateUpdateProviderAvailability = [
	body("isProviderAvailable")
		.exists()
		.withMessage("isProviderAvailable is required")
		.isBoolean({ strict: true })
		.withMessage("isProviderAvailable must be a boolean"),
	body("currentLocation")
		.optional({ values: "null" })
		.isObject()
		.withMessage("currentLocation must be an object")
		.custom((value) => {
			if (!("latitude" in value) || !("longitude" in value)) {
				throw new Error("currentLocation must have latitude and longitude properties");
			}
			if (!isLatitude(value.latitude) || !isLongitude(value.longitude)) {
				throw new Error("latitude and longitude must be valid coordinates");
			}
			return true;
		}),
	body("selectedJobTypes")
		.optional()
		.isArray({ min: 1, max: 3 })
		.withMessage("selectedJobTypes must be a non-empty array")
		.custom((ids) => ids.every((id: unknown) => [1, 2, 3].includes(Number(id))))
		.withMessage("selectedJobTypes may only contain 1, 2 or 3"),
];

export const validateBookingIdBody = [bookingIdInBody, rejectIfInvalid];

export const validateCreatePayoutFields = [
	body("amount")
		.custom((value) => typeof value === "number" && Number.isInteger(value) && value >= 20 && value <= 1_000_000)
		.withMessage("Valid amount is required."),
	rejectIfInvalid,
];
