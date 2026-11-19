import { body } from "express-validator";
import { MAX_ADDRESS_LENGTH, MAX_TEXT_LENGTH, bookingIdInBody, rejectIfInvalid } from "./common.validators";
import { LOCATION_SOURCES } from "../../../dal/models/booking.model";
import { PLACE_ID } from "../../../lib/places";

const optionalText = (field: string, max: number) =>
	body(field)
		.optional({ values: "null" })
		.isString()
		.withMessage(`${field} must be text`)
		.bail()
		.trim()
		.isLength({ max })
		.withMessage(`${field} must be at most ${max} characters`);
import { checkBookingRange, getSettings } from "../../../lib/settings";

/** The same check and message as isInt({ min, max }) with the bounds from the settings. */
const bookingRange = (field: "rate" | "hours") => async (value: unknown) => {
	const problem = checkBookingRange(field, value, await getSettings());
	if (problem) throw new Error(problem);
	return true;
};

export const validateCreateBookingFields = [
	body("service").isInt({ min: 1, max: 3 }).withMessage("Selected service must be 1, 2, or 3"),
	// Bounds come from the platform settings (lib/settings.ts); the defaults are 20-2000 and 1-1000, as before.
	body("rate").isNumeric().notEmpty().withMessage("Rate must be a non-empty number").custom(bookingRange("rate")),
	body("hours").isNumeric().notEmpty().withMessage("Hours must be a non-empty number").custom(bookingRange("hours")),
	body("startDate").isISO8601().notEmpty().withMessage("Start date must be a ISO8601 non-empty date format"),
	body("startTime").isISO8601().notEmpty().withMessage("Start time must be a ISO8601 non-empty time format"),
	body("startAt").optional().isISO8601().withMessage("Start must be an ISO8601 date and time"),
	body("address")
		.isString()
		.notEmpty()
		.withMessage("Address must be a non-empty string")
		.isLength({ max: MAX_ADDRESS_LENGTH })
		.withMessage(`Address must be at most ${MAX_ADDRESS_LENGTH} characters`),
	body("latitude").isFloat({ min: -90, max: 90 }).withMessage("Latitude must be a number between -90 and 90"),
	body("longitude").isFloat({ min: -180, max: 180 }).withMessage("Longitude must be a number between -180 and 180"),
	// Optional, from the address picker (older apps send none of these).
	body("placeId").optional({ values: "null" }).isString().matches(PLACE_ID).withMessage("placeId is not valid"),
	optionalText("formattedAddress", MAX_ADDRESS_LENGTH),
	optionalText("placeName", MAX_TEXT_LENGTH),
	optionalText("customAddress", MAX_ADDRESS_LENGTH),
	body("locationSource")
		.optional({ values: "null" })
		.isIn(LOCATION_SOURCES)
		.withMessage(`locationSource must be one of ${LOCATION_SOURCES.join(", ")}`),
];

export const validateBookingIdField = [bookingIdInBody, rejectIfInvalid];
