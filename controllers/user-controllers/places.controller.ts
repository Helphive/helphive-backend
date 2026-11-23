// Address lookup for signed-in customers and providers (routes/user-routes/places.route.ts). Thin handlers over
// lib/places.ts; the contract is in scratch/address/address-contract.md. Typed text, addresses and coordinates are
// never logged: errors log only the code and Google's status.
import { Request, Response } from "express";
import { PlacesError, placesClient, type LatLng } from "../../lib/places";
import log from "../../lib/logger";

/** Attribution the clients must show next to suggestions that are not on a Google map. */
const ATTRIBUTION = "Google Maps";

const userKey = (req: Request) => req.context?.actor?.id ?? String(req.user ?? "");

const answer = (res: Response, error: unknown, what: string) => {
	if (error instanceof PlacesError) {
		if (error.code !== "places_not_configured" && error.code !== "places_not_found") {
			log.warn("address_lookup_failed", `Address lookup failed (${what})`, {
				code: error.code,
				upstream: error.upstream ?? null,
			});
		}
		return res.status(error.status).json(error.toBody());
	}
	log.error(
		"address_lookup_error",
		`Address lookup error (${what})`,
		error instanceof Error ? error.name : "unknown",
	);
	return res.status(502).json(new PlacesError("places_unavailable").toBody());
};

const optionalString = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** GET /auth/places/status: whether search is available, so a client can go straight to the map-pin fallback. */
export const handlePlacesStatus = (_req: Request, res: Response) => {
	res.json({ configured: placesClient.configured, attribution: ATTRIBUTION });
};

/** POST /auth/places/autocomplete { input, sessionToken, near?, languageCode?, regionCode? } */
export const handleAutocomplete = async (req: Request, res: Response) => {
	try {
		const { input, sessionToken, near } = req.body;
		const result = await placesClient.autocomplete(userKey(req), {
			input,
			sessionToken,
			near: near
				? {
						latitude: Number(near.latitude),
						longitude: Number(near.longitude),
						radiusMeters: near.radiusMeters === undefined ? undefined : Number(near.radiusMeters),
					}
				: undefined,
			languageCode: optionalString(req.body.languageCode),
			regionCode: optionalString(req.body.regionCode),
		});
		res.json({ ...result, attribution: ATTRIBUTION });
	} catch (error) {
		answer(res, error, "autocomplete");
	}
};

/** POST /auth/places/details { placeId, sessionToken?, languageCode? }: ends the search session. */
export const handlePlaceDetails = async (req: Request, res: Response) => {
	try {
		const place = await placesClient.placeDetails(
			userKey(req),
			req.body.placeId,
			optionalString(req.body.sessionToken),
			optionalString(req.body.languageCode),
		);
		res.json({ place, attribution: ATTRIBUTION });
	} catch (error) {
		answer(res, error, "details");
	}
};

/** POST /auth/places/reverse-geocode { latitude, longitude, languageCode? } */
export const handleReverseGeocode = async (req: Request, res: Response) => {
	try {
		const point: LatLng = { latitude: Number(req.body.latitude), longitude: Number(req.body.longitude) };
		const { results } = await placesClient.reverseGeocode(point, optionalString(req.body.languageCode));
		res.json({ best: results[0] ?? null, results, attribution: ATTRIBUTION });
	} catch (error) {
		answer(res, error, "reverse geocode");
	}
};
