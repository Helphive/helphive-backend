import { body } from "express-validator";

export const validateCreateBookingFields = [
	body("service").isInt({ min: 1, max: 3 }).withMessage("Selected service must be 1, 2, or 3"),
	body("rate")
		.isNumeric()
		.notEmpty()
		.withMessage("Rate must be a non-empty number")
		.isInt({ min: 20, max: 2000 })
		.withMessage("Rate must be between 20 and 2000"),
	body("hours")
		.isNumeric()
		.notEmpty()
		.withMessage("Hours must be a non-empty number")
		.isInt({ min: 1, max: 1000 })
		.withMessage("Hours must be between 1 and 1000"),
	body("startDate").isISO8601().notEmpty().withMessage("Start date must be a ISO8601 non-empty date format"),
	body("startTime").isISO8601().notEmpty().withMessage("Start time must be a ISO8601 non-empty time format"),
	body("address").isString().notEmpty().withMessage("Address must be a non-empty string"),
	body("latitude").isNumeric().notEmpty().withMessage("Latitude must be a non-empty number"),
	body("longitude").isNumeric().notEmpty().withMessage("Longitude must be a non-empty number"),
];
