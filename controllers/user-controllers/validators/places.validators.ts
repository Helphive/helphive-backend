import { NextFunction, Request, Response } from "express";
import { body } from "express-validator";
import { rejectIfInvalid } from "./common.validators";
import {
	LANGUAGE_CODE,
	MAX_BIAS_RADIUS_M,
	MAX_INPUT_LENGTH,
	PLACE_ID,
	REGION_CODE,
	SESSION_TOKEN,
} from "../../../lib/places";

/** Validation failures answer 400 with the same typed code as the other address errors. */
const rejectWithCode = (req: Request, res: Response, next: NextFunction) => {
	const send = res.json.bind(res);
	res.json = (payload?: any) =>
		send(
			res.statusCode === 400 && payload && !payload.code
				? { ...payload, code: "places_invalid_request" }
				: payload,
		);
	rejectIfInvalid(req, res, next);
};

const sessionToken = (required: boolean) => {
	const chain = body("sessionToken");
	return (required ? chain : chain.optional())
		.isString()
		.matches(SESSION_TOKEN)
		.withMessage("sessionToken must be a UUID (or 16-36 letters, digits, '-' or '_').");
};

const language = [
	body("languageCode")
		.optional()
		.isString()
		.matches(LANGUAGE_CODE)
		.withMessage("languageCode must be a language tag such as en or en-GB."),
];

export const validateAutocomplete = [
	body("input")
		.isString()
		.withMessage("input must be text.")
		.bail()
		.trim()
		.isLength({ min: 1, max: MAX_INPUT_LENGTH })
		.withMessage(`input must be 1 to ${MAX_INPUT_LENGTH} characters.`),
	sessionToken(true),
	body("near").optional().isObject().withMessage("near must be { latitude, longitude, radiusMeters? }."),
	body("near.latitude")
		.if(body("near").exists())
		.isFloat({ min: -90, max: 90 })
		.withMessage("near.latitude must be between -90 and 90."),
	body("near.longitude")
		.if(body("near").exists())
		.isFloat({ min: -180, max: 180 })
		.withMessage("near.longitude must be between -180 and 180."),
	body("near.radiusMeters")
		.optional()
		.isFloat({ min: 1, max: MAX_BIAS_RADIUS_M })
		.withMessage(`near.radiusMeters must be between 1 and ${MAX_BIAS_RADIUS_M}.`),
	...language,
	body("regionCode")
		.optional()
		.isString()
		.matches(REGION_CODE)
		.withMessage("regionCode must be a two-letter code such as gb."),
	rejectWithCode,
];

export const validatePlaceDetails = [
	body("placeId").isString().matches(PLACE_ID).withMessage("placeId is not valid."),
	sessionToken(false),
	...language,
	rejectWithCode,
];

export const validateReverseGeocode = [
	body("latitude").isFloat({ min: -90, max: 90 }).withMessage("latitude must be between -90 and 90."),
	body("longitude").isFloat({ min: -180, max: 180 }).withMessage("longitude must be between -180 and 180."),
	...language,
	rejectWithCode,
];
