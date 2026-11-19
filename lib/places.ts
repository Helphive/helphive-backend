// Address lookup through the server: Google Places API (New) Autocomplete and Place Details, and the Geocoding API
// for reverse geocoding. The key (GOOGLE_MAPS_SERVER_API_KEY) never leaves the server. Request building and response
// mapping are pure functions (tests run them against recorded responses); `placesClient` does the HTTP.
//
// Billing: autocomplete calls and the place-details call that follows carry the same client session token, so Google
// bills the search once per session; details ask only for the fields in DETAILS_FIELD_MASK.
// Caching follows the Places policies: no suggestion lists or addresses are cached across people. The only reuse is
// a selected place's details for the same person and the same session (the selected address belongs to that person's
// transaction), which also keeps a double tap from being billed twice. Identical requests in flight share one call.
// Nothing here logs the text typed, an address or coordinates.
import axios from "axios";

export type PlacesErrorCode =
	| "places_not_configured"
	| "places_invalid_request"
	| "places_not_found"
	| "places_unavailable"
	| "places_timeout";

const STATUS: Record<PlacesErrorCode, number> = {
	places_not_configured: 503,
	places_invalid_request: 400,
	places_not_found: 404,
	places_unavailable: 502,
	places_timeout: 504,
};

const MESSAGES: Record<PlacesErrorCode, string> = {
	places_not_configured: "Address search is not available. Pin the location on the map and type the address.",
	places_invalid_request: "The address search request is not valid.",
	places_not_found: "That place could not be found. Search again or pin it on the map.",
	places_unavailable: "Address search is temporarily unavailable. Pin the location on the map and type the address.",
	places_timeout: "Address search took too long. Try again, or pin the location on the map.",
};

export class PlacesError extends Error {
	readonly status: number;
	constructor(
		readonly code: PlacesErrorCode,
		/** Google's own status for the server log (never shown to clients). */
		readonly upstream?: string,
	) {
		super(MESSAGES[code]);
		this.status = STATUS[code];
	}
	toBody() {
		return { message: this.message, code: this.code };
	}
}

export interface LatLng {
	latitude: number;
	longitude: number;
}

// --- Validation helpers (also used by the route validators) ----------------------------------------------------

/** Google's rule: URL- and filename-safe, at most 36 characters. A UUID v4 is what clients should send. */
export const SESSION_TOKEN = /^[A-Za-z0-9_-]{16,36}$/;
/** Place ids are opaque base64-like strings; generous bounds, no other characters. */
export const PLACE_ID = /^[A-Za-z0-9_-]{10,512}$/;
export const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const REGION_CODE = /^[a-z]{2}$/;
export const MAX_INPUT_LENGTH = 200;
export const DEFAULT_BIAS_RADIUS_M = 20_000;
export const MAX_BIAS_RADIUS_M = 50_000;

const isLatLng = (value: unknown): value is LatLng =>
	!!value &&
	typeof (value as LatLng).latitude === "number" &&
	typeof (value as LatLng).longitude === "number" &&
	Number.isFinite((value as LatLng).latitude) &&
	Number.isFinite((value as LatLng).longitude) &&
	Math.abs((value as LatLng).latitude) <= 90 &&
	Math.abs((value as LatLng).longitude) <= 180;

// --- Autocomplete ---------------------------------------------------------------------------------------------

export const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
// Only what the picker shows; everything else in the response is dropped by Google before it is sent.
export const AUTOCOMPLETE_FIELD_MASK = [
	"suggestions.placePrediction.placeId",
	"suggestions.placePrediction.text.text",
	"suggestions.placePrediction.structuredFormat.mainText.text",
	"suggestions.placePrediction.structuredFormat.secondaryText.text",
	"suggestions.placePrediction.types",
	"suggestions.placePrediction.distanceMeters",
].join(",");

export interface AutocompleteInput {
	input: string;
	sessionToken: string;
	near?: LatLng & { radiusMeters?: number };
	languageCode?: string;
	regionCode?: string;
}

export interface HttpRequest {
	method: "GET" | "POST";
	url: string;
	headers: Record<string, string>;
	body?: unknown;
	timeoutMs: number;
}

/** The autocomplete call, without the key (added when sent). Worldwide, establishments included, biased when `near`. */
export const buildAutocompleteRequest = (input: AutocompleteInput): HttpRequest => {
	const body: Record<string, unknown> = {
		input: input.input.trim().slice(0, MAX_INPUT_LENGTH),
		sessionToken: input.sessionToken,
		includeQueryPredictions: false,
	};
	if (input.near && isLatLng(input.near)) {
		const radius = Math.min(Math.max(input.near.radiusMeters ?? DEFAULT_BIAS_RADIUS_M, 1), MAX_BIAS_RADIUS_M);
		const center = { latitude: input.near.latitude, longitude: input.near.longitude };
		body.locationBias = { circle: { center, radius } };
		body.origin = center;
	}
	if (input.languageCode) body.languageCode = input.languageCode;
	if (input.regionCode) body.regionCode = input.regionCode;
	return {
		method: "POST",
		url: AUTOCOMPLETE_URL,
		headers: { "Content-Type": "application/json", "X-Goog-FieldMask": AUTOCOMPLETE_FIELD_MASK },
		body,
		timeoutMs: 3000,
	};
};

export type PlaceKind = "establishment" | "address" | "area";

/** Establishment (hotel, venue), a street address, or an area (city, region) from Google's types. */
export const placeKind = (types: unknown): PlaceKind => {
	const list = Array.isArray(types) ? types.filter((t): t is string => typeof t === "string") : [];
	if (list.includes("establishment") || list.includes("point_of_interest") || list.includes("lodging"))
		return "establishment";
	if (
		list.some((t) =>
			["street_address", "premise", "subpremise", "route", "street_number", "plus_code", "postal_code"].includes(
				t,
			),
		)
	)
		return "address";
	return list.length ? "area" : "address";
};

export interface Suggestion {
	placeId: string;
	primaryText: string;
	secondaryText: string | null;
	fullText: string;
	kind: PlaceKind;
	types: string[];
	distanceMeters: number | null;
}

const text = (value: unknown): string | null => {
	const t = (value as { text?: unknown } | undefined)?.text;
	return typeof t === "string" && t ? t : null;
};

export const mapAutocompleteResponse = (json: unknown): { suggestions: Suggestion[] } => {
	const raw = (json as { suggestions?: unknown })?.suggestions;
	const suggestions: Suggestion[] = [];
	for (const item of Array.isArray(raw) ? raw : []) {
		const p = (item as { placePrediction?: any })?.placePrediction;
		if (!p || typeof p.placeId !== "string" || !PLACE_ID.test(p.placeId)) continue;
		const full = text(p.text);
		const primary = text(p.structuredFormat?.mainText) ?? full;
		if (!primary) continue;
		const types = Array.isArray(p.types) ? p.types.filter((t: unknown) => typeof t === "string") : [];
		suggestions.push({
			placeId: p.placeId,
			primaryText: primary,
			secondaryText: text(p.structuredFormat?.secondaryText),
			fullText: full ?? primary,
			kind: placeKind(types),
			types,
			// Google omits it when under a metre or without an origin; never report a made-up zero.
			distanceMeters: typeof p.distanceMeters === "number" && p.distanceMeters > 0 ? p.distanceMeters : null,
		});
	}
	return { suggestions };
};

// --- Place details --------------------------------------------------------------------------------------------

// displayName (the hotel or venue name) is a Pro field; the rest are Essentials. Nothing else is requested.
export const DETAILS_FIELD_MASK = "id,displayName,formattedAddress,location,addressComponents,types";

export const buildDetailsRequest = (placeId: string, sessionToken?: string, languageCode?: string): HttpRequest => {
	const params = new URLSearchParams();
	if (sessionToken) params.set("sessionToken", sessionToken);
	if (languageCode) params.set("languageCode", languageCode);
	const query = params.toString();
	return {
		method: "GET",
		url: `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${query ? `?${query}` : ""}`,
		headers: { "X-Goog-FieldMask": DETAILS_FIELD_MASK },
		timeoutMs: 4000,
	};
};

export interface AddressParts {
	streetNumber: string | null;
	route: string | null;
	premise: string | null;
	subpremise: string | null;
	neighborhood: string | null;
	locality: string | null;
	postalTown: string | null;
	administrativeArea: string | null;
	postalCode: string | null;
	country: string | null;
	countryCode: string | null;
}

interface Component {
	long: string;
	short: string;
	types: string[];
}

/** Address parts from either API's components (Places New: longText/shortText; Geocoding: long_name/short_name). */
export const mapAddressParts = (components: unknown): AddressParts => {
	const list: Component[] = (Array.isArray(components) ? components : [])
		.map((c: any) => ({
			long: String(c?.longText ?? c?.long_name ?? ""),
			short: String(c?.shortText ?? c?.short_name ?? ""),
			types: Array.isArray(c?.types) ? c.types.filter((t: unknown) => typeof t === "string") : [],
		}))
		.filter((c) => c.long);
	const find = (type: string) => list.find((c) => c.types.includes(type));
	const long = (type: string) => find(type)?.long ?? null;
	return {
		streetNumber: long("street_number"),
		route: long("route"),
		premise: long("premise"),
		subpremise: long("subpremise"),
		neighborhood: long("neighborhood") ?? long("sublocality"),
		locality: long("locality") ?? long("postal_town"),
		postalTown: long("postal_town"),
		administrativeArea: long("administrative_area_level_1"),
		postalCode: long("postal_code"),
		country: long("country"),
		countryCode: find("country")?.short ?? null,
	};
};

export interface PlaceResult {
	placeId: string;
	name: string | null;
	formattedAddress: string;
	location: LatLng;
	addressParts: AddressParts;
	kind: PlaceKind;
	types: string[];
}

export const mapDetailsResponse = (json: any): PlaceResult => {
	const location = json?.location;
	if (typeof json?.id !== "string" || typeof json?.formattedAddress !== "string" || !isLatLng(location)) {
		throw new PlacesError("places_not_found", "incomplete_details");
	}
	const types = Array.isArray(json.types) ? json.types.filter((t: unknown) => typeof t === "string") : [];
	const kind = placeKind(types);
	return {
		placeId: json.id,
		// Only a business or landmark has a name worth showing; for a plain address displayName repeats the street.
		name: kind === "establishment" ? text(json.displayName) : null,
		formattedAddress: json.formattedAddress,
		location: { latitude: location.latitude, longitude: location.longitude },
		addressParts: mapAddressParts(json.addressComponents),
		kind,
		types,
	};
};

// --- Reverse geocoding (Geocoding API) ------------------------------------------------------------------------

export const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export const buildReverseGeocodeRequest = (point: LatLng, languageCode?: string): HttpRequest => {
	const params = new URLSearchParams({ latlng: `${point.latitude},${point.longitude}` });
	if (languageCode) params.set("language", languageCode);
	return { method: "GET", url: `${GEOCODE_URL}?${params}`, headers: {}, timeoutMs: 4000 };
};

export interface ReverseResult {
	placeId: string;
	formattedAddress: string;
	location: LatLng;
	addressParts: AddressParts;
	kind: PlaceKind;
	types: string[];
}

const MAX_REVERSE_RESULTS = 3;

/** The closest few results (Google orders them most specific first). ZERO_RESULTS is an empty list, not an error. */
export const mapReverseGeocodeResponse = (json: any): { results: ReverseResult[] } => {
	const status = json?.status;
	if (status === "ZERO_RESULTS") return { results: [] };
	if (status !== "OK") throw upstreamStatusError(typeof status === "string" ? status : "UNKNOWN");
	const results: ReverseResult[] = [];
	for (const r of Array.isArray(json.results) ? json.results : []) {
		const loc = r?.geometry?.location;
		const point = loc ? { latitude: loc.lat, longitude: loc.lng } : null;
		if (typeof r?.place_id !== "string" || typeof r?.formatted_address !== "string" || !isLatLng(point)) continue;
		const types = Array.isArray(r.types) ? r.types.filter((t: unknown) => typeof t === "string") : [];
		results.push({
			placeId: r.place_id,
			formattedAddress: r.formatted_address,
			location: point,
			addressParts: mapAddressParts(r.address_components),
			kind: placeKind(types),
			types,
		});
		if (results.length >= MAX_REVERSE_RESULTS) break;
	}
	return { results };
};

/** Geocoding API `status` values and Places API (New) error statuses to our codes. */
export const upstreamStatusError = (status: string): PlacesError => {
	switch (status) {
		case "INVALID_REQUEST":
		case "INVALID_ARGUMENT":
			return new PlacesError("places_invalid_request", status);
		case "NOT_FOUND":
			return new PlacesError("places_not_found", status);
		default:
			// REQUEST_DENIED / PERMISSION_DENIED (key or API not enabled), OVER_QUERY_LIMIT / RESOURCE_EXHAUSTED, errors.
			return new PlacesError("places_unavailable", status);
	}
};

/** Error for a Places API (New) HTTP answer that is not 2xx. */
export const httpError = (status: number, body: any): PlacesError => {
	const googleStatus = typeof body?.error?.status === "string" ? body.error.status : `HTTP_${status}`;
	if (status === 404) return new PlacesError("places_not_found", googleStatus);
	if (status === 400) return upstreamStatusError(googleStatus === `HTTP_400` ? "INVALID_ARGUMENT" : googleStatus);
	return new PlacesError("places_unavailable", googleStatus);
};

// --- Small in-memory caches -----------------------------------------------------------------------------------

/** Fixed-size map with expiry; the oldest entry goes when full. Per instance. */
export class TtlCache<V> {
	private readonly entries = new Map<string, { value: V; expiresAt: number }>();
	constructor(
		private readonly ttlMs: number,
		private readonly maxEntries: number,
		private readonly now: () => number = Date.now,
	) {}

	get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: V) {
		this.entries.delete(key);
		if (this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
	}

	get size() {
		return this.entries.size;
	}
}

/** Shares one in-flight promise between identical concurrent calls (nothing is kept once it settles). */
export class InFlight<V> {
	private readonly pending = new Map<string, Promise<V>>();
	run(key: string, fn: () => Promise<V>): Promise<V> {
		const existing = this.pending.get(key);
		if (existing) return existing;
		const promise = fn().finally(() => this.pending.delete(key));
		this.pending.set(key, promise);
		return promise;
	}
}

/** Key for in-flight sharing of autocomplete calls: same person, session, text and bias. */
export const autocompleteKey = (userKey: string, input: AutocompleteInput) =>
	JSON.stringify([
		userKey,
		input.sessionToken,
		input.input.trim().toLowerCase().replace(/\s+/g, " "),
		input.near ? [input.near.latitude, input.near.longitude, input.near.radiusMeters ?? null] : null,
		input.languageCode ?? null,
		input.regionCode ?? null,
	]);

/** Same person, same session, same place: the selected address of that person's own transaction. */
export const detailsKey = (userKey: string, placeId: string, sessionToken: string | undefined, language?: string) =>
	JSON.stringify([userKey, sessionToken ?? null, placeId, language ?? null]);

// --- Client ---------------------------------------------------------------------------------------------------

export type Transport = (request: HttpRequest & { apiKey: string }) => Promise<{ status: number; data: any }>;

/** Sends with the key in a header (Places) or the query string (Geocoding, which only accepts `key=`). */
export const axiosTransport: Transport = async (request) => {
	const isGeocode = request.url.startsWith(GEOCODE_URL);
	const url = isGeocode ? `${request.url}&key=${encodeURIComponent(request.apiKey)}` : request.url;
	try {
		const response = await axios.request({
			method: request.method,
			url,
			headers: isGeocode ? request.headers : { ...request.headers, "X-Goog-Api-Key": request.apiKey },
			data: request.body,
			timeout: request.timeoutMs,
			validateStatus: () => true,
			maxContentLength: 1_000_000,
		});
		return { status: response.status, data: response.data };
	} catch (error: any) {
		if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT")
			throw new PlacesError("places_timeout", "timeout");
		throw new PlacesError("places_unavailable", error?.code ?? "network");
	}
};

export const placesApiKey = (env: NodeJS.ProcessEnv = process.env) => env.GOOGLE_MAPS_SERVER_API_KEY?.trim() || "";

export const DETAILS_CACHE_TTL_MS = 10 * 60 * 1000;

export const createPlacesClient = (
	options: { apiKey?: () => string; transport?: Transport; now?: () => number } = {},
) => {
	const apiKey = options.apiKey ?? (() => placesApiKey());
	const transport = options.transport ?? axiosTransport;
	const details = new TtlCache<PlaceResult>(DETAILS_CACHE_TTL_MS, 5000, options.now);
	const autocompleteInFlight = new InFlight<{ suggestions: Suggestion[] }>();
	const detailsInFlight = new InFlight<PlaceResult>();

	const send = async (request: HttpRequest) => {
		const key = apiKey();
		if (!key) throw new PlacesError("places_not_configured");
		return transport({ ...request, apiKey: key });
	};

	return {
		get configured() {
			return !!apiKey();
		},
		details,

		autocomplete(userKey: string, input: AutocompleteInput) {
			if (!apiKey()) return Promise.reject(new PlacesError("places_not_configured"));
			return autocompleteInFlight.run(autocompleteKey(userKey, input), async () => {
				const { status, data } = await send(buildAutocompleteRequest(input));
				if (status < 200 || status >= 300) throw httpError(status, data);
				return mapAutocompleteResponse(data);
			});
		},

		placeDetails(userKey: string, placeId: string, sessionToken?: string, languageCode?: string) {
			if (!apiKey()) return Promise.reject(new PlacesError("places_not_configured"));
			const key = detailsKey(userKey, placeId, sessionToken, languageCode);
			const cached = details.get(key);
			if (cached) return Promise.resolve(cached);
			return detailsInFlight.run(key, async () => {
				const { status, data } = await send(buildDetailsRequest(placeId, sessionToken, languageCode));
				if (status < 200 || status >= 300) throw httpError(status, data);
				const result = mapDetailsResponse(data);
				details.set(key, result);
				return result;
			});
		},

		async reverseGeocode(point: LatLng, languageCode?: string) {
			const { status, data } = await send(buildReverseGeocodeRequest(point, languageCode));
			if (status < 200 || status >= 300) throw new PlacesError("places_unavailable", `HTTP_${status}`);
			return mapReverseGeocodeResponse(data);
		},
	};
};

export type PlacesClient = ReturnType<typeof createPlacesClient>;

export const placesClient = createPlacesClient();
