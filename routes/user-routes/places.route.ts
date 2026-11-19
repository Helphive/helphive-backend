// Address lookup for signed-in customers and providers, mounted at /auth/places. POST bodies keep typed text and
// coordinates out of URLs (and so out of access logs and proxies). Every route: authentication, a rate limit, then
// validation (tests/newRoutes.test.ts checks it).
import express from "express";
import { verifyJWT } from "../../middleware/verifyJWT";
import { verifyRoles } from "../../middleware/verfiyRoles";
import { placesLimiters } from "../../middleware/rateLimit";
import {
	handleAutocomplete,
	handlePlaceDetails,
	handlePlacesStatus,
	handleReverseGeocode,
} from "../../controllers/user-controllers/places.controller";
import {
	validateAutocomplete,
	validatePlaceDetails,
	validateReverseGeocode,
} from "../../controllers/user-controllers/validators/places.validators";
import { validateNoInput } from "../../controllers/user-controllers/validators/common.validators";

const placesRoute = express.Router();

const signedIn = [verifyJWT, verifyRoles("User", "Provider")];

placesRoute.get("/status", ...signedIn, ...placesLimiters, validateNoInput, handlePlacesStatus);
placesRoute.post("/autocomplete", ...signedIn, ...placesLimiters, ...validateAutocomplete, handleAutocomplete);
placesRoute.post("/details", ...signedIn, ...placesLimiters, ...validatePlaceDetails, handlePlaceDetails);
placesRoute.post("/reverse-geocode", ...signedIn, ...placesLimiters, ...validateReverseGeocode, handleReverseGeocode);

export default placesRoute;
