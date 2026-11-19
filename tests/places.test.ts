// Run with: npx ts-node tests/places.test.ts
// Address lookup without the network: request building and response mapping against recorded-shape fixtures
// (tests/fixtures/places), session tokens, the caches, error mapping, and the booking address fields.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
	AUTOCOMPLETE_URL,
	DETAILS_CACHE_TTL_MS,
	DETAILS_FIELD_MASK,
	InFlight,
	PlacesError,
	SESSION_TOKEN,
	TtlCache,
	buildAutocompleteRequest,
	buildDetailsRequest,
	buildReverseGeocodeRequest,
	createPlacesClient,
	httpError,
	mapAutocompleteResponse,
	mapDetailsResponse,
	mapReverseGeocodeResponse,
	placeKind,
	type HttpRequest,
} from "../lib/places";
import { bookingAddressFields, bookingDisplayAddress } from "../controllers/user-controllers/utils/booking.utils";

const fixture = (name: string) =>
	JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "places", `${name}.json`), "utf8"));

const TOKEN = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

test("autocomplete request: POST to Places (New), field mask, session token, worldwide, establishments included", () => {
	const request = buildAutocompleteRequest({ input: "  savoy  ", sessionToken: TOKEN });
	assert.equal(request.method, "POST");
	assert.equal(request.url, AUTOCOMPLETE_URL);
	assert.match(request.headers["X-Goog-FieldMask"], /suggestions\.placePrediction\.placeId/);
	assert.ok(!request.headers["X-Goog-FieldMask"].includes("*"), "never the wildcard mask");
	assert.equal(request.headers["X-Goog-Api-Key"], undefined, "the key is added only by the transport");
	const body = request.body as any;
	assert.equal(body.input, "savoy");
	assert.equal(body.sessionToken, TOKEN);
	assert.equal(body.includeQueryPredictions, false);
	assert.equal(body.includedPrimaryTypes, undefined, "hotels and venues are not filtered out");
	assert.equal(body.includedRegionCodes, undefined, "worldwide");
	assert.equal(body.locationBias, undefined, "no bias without a location");
	assert.ok(request.timeoutMs <= 5000);
});

test("autocomplete request: bias toward the caller (circle, radius clamped to Google's 50 km), origin for distances", () => {
	const body = buildAutocompleteRequest({
		input: "hotel",
		sessionToken: TOKEN,
		near: { latitude: 51.5, longitude: -0.12, radiusMeters: 900_000 },
		languageCode: "en-GB",
		regionCode: "gb",
	}).body as any;
	assert.deepEqual(body.locationBias, { circle: { center: { latitude: 51.5, longitude: -0.12 }, radius: 50_000 } });
	assert.deepEqual(body.origin, { latitude: 51.5, longitude: -0.12 });
	assert.equal(body.languageCode, "en-GB");
	assert.equal(body.regionCode, "gb");
	const defaultRadius = buildAutocompleteRequest({
		input: "x",
		sessionToken: TOKEN,
		near: { latitude: 0, longitude: 0 },
	}).body as any;
	assert.equal(defaultRadius.locationBias.circle.radius, 20_000);
	const invalid = buildAutocompleteRequest({
		input: "x",
		sessionToken: TOKEN,
		near: { latitude: 120, longitude: 0 },
	}).body as any;
	assert.equal(invalid.locationBias, undefined, "an impossible point is ignored");
});

test("autocomplete response: places only, kinds, no made-up zero distance, bad ids dropped", () => {
	const { suggestions } = mapAutocompleteResponse(fixture("autocomplete"));
	assert.equal(suggestions.length, 3);
	assert.deepEqual(suggestions[0], {
		placeId: "ChIJdd4hrwug2EcRmSrV3Vo6llI",
		primaryText: "The Savoy",
		secondaryText: "Strand, London, UK",
		fullText: "The Savoy, Strand, London, UK",
		kind: "establishment",
		types: ["lodging", "point_of_interest", "establishment"],
		distanceMeters: 1820,
	});
	assert.equal(suggestions[1].kind, "address");
	assert.equal(suggestions[1].distanceMeters, null, "0 means under a metre or unknown");
	assert.equal(suggestions[2].secondaryText, null);
	assert.deepEqual(mapAutocompleteResponse({}), { suggestions: [] });
	assert.deepEqual(mapAutocompleteResponse(null), { suggestions: [] });
});

test("details request: GET by place id with the same session token and only the needed fields", () => {
	const request = buildDetailsRequest("ChIJdd4hrwug2EcRmSrV3Vo6llI", TOKEN, "en");
	assert.equal(request.method, "GET");
	assert.equal(
		request.url,
		`https://places.googleapis.com/v1/places/ChIJdd4hrwug2EcRmSrV3Vo6llI?sessionToken=${TOKEN}&languageCode=en`,
	);
	assert.equal(request.headers["X-Goog-FieldMask"], DETAILS_FIELD_MASK);
	assert.deepEqual(DETAILS_FIELD_MASK.split(","), [
		"id",
		"displayName",
		"formattedAddress",
		"location",
		"addressComponents",
		"types",
	]);
	assert.equal(buildDetailsRequest("ChIJdd4hrwug2EcRmSrV3Vo6llI").url.includes("?"), false);
});

test("details response: hotel name, formatted address, coordinates and address parts", () => {
	const hotel = mapDetailsResponse(fixture("details-hotel"));
	assert.equal(hotel.name, "The Savoy");
	assert.equal(hotel.kind, "establishment");
	assert.equal(hotel.formattedAddress, "Strand, London WC2R 0EZ, UK");
	assert.deepEqual(hotel.location, { latitude: 51.5104, longitude: -0.1203 });
	assert.equal(hotel.addressParts.route, "Strand");
	assert.equal(hotel.addressParts.locality, "London", "postal_town stands in for locality in the UK");
	assert.equal(hotel.addressParts.postalCode, "WC2R 0EZ");
	assert.equal(hotel.addressParts.countryCode, "GB");
	const address = mapDetailsResponse(fixture("details-address"));
	assert.equal(address.name, null, "a plain address has no name to show");
	assert.equal(address.addressParts.streetNumber, "100");
	assert.throws(
		() => mapDetailsResponse({ id: "x" }),
		(e: any) => e instanceof PlacesError && e.status === 404,
	);
});

test("reverse geocoding: Geocoding API request without the key, best results first, ZERO_RESULTS is empty", () => {
	const request = buildReverseGeocodeRequest({ latitude: 51.5103, longitude: -0.1205 }, "en");
	assert.equal(request.url, "https://maps.googleapis.com/maps/api/geocode/json?latlng=51.5103%2C-0.1205&language=en");
	assert.ok(!request.url.includes("key="));
	const { results } = mapReverseGeocodeResponse(fixture("geocode-ok"));
	assert.equal(results.length, 3, "at most three, invalid ones skipped");
	assert.equal(results[0].formattedAddress, "1 Savoy Ct, London WC2R 0EZ, UK");
	assert.deepEqual(results[0].location, { latitude: 51.5103, longitude: -0.1205 });
	assert.equal(results[0].addressParts.route, "Savoy Court");
	assert.equal(results[1].kind, "area");
	assert.deepEqual(mapReverseGeocodeResponse(fixture("geocode-zero")), { results: [] });
	assert.throws(
		() => mapReverseGeocodeResponse(fixture("geocode-denied")),
		(e: any) => e.code === "places_unavailable" && e.upstream === "REQUEST_DENIED",
	);
});

test("errors are typed: status, code and a message for people; Google's own status kept for the log only", () => {
	const denied = httpError(403, fixture("places-error-403"));
	assert.equal(denied.code, "places_unavailable");
	assert.equal(denied.status, 502);
	assert.equal(denied.upstream, "PERMISSION_DENIED");
	assert.deepEqual(Object.keys(denied.toBody()).sort(), ["code", "message"]);
	assert.equal(httpError(404, {}).code, "places_not_found");
	assert.equal(httpError(400, {}).code, "places_invalid_request");
	assert.equal(httpError(429, { error: { status: "RESOURCE_EXHAUSTED" } }).code, "places_unavailable");
	const notConfigured = new PlacesError("places_not_configured");
	assert.equal(notConfigured.status, 503);
	assert.match(notConfigured.message, /map/);
});

test("session tokens: UUIDs and URL-safe strings up to 36 characters", () => {
	assert.ok(SESSION_TOKEN.test(TOKEN));
	assert.ok(SESSION_TOKEN.test("abcdefABCDEF0123_-xy"));
	assert.ok(!SESSION_TOKEN.test("short"));
	assert.ok(!SESSION_TOKEN.test("a".repeat(37)));
	assert.ok(!SESSION_TOKEN.test("has space in it 1234"));
});

test("place kinds", () => {
	assert.equal(placeKind(["lodging"]), "establishment");
	assert.equal(placeKind(["premise"]), "address");
	assert.equal(placeKind(["locality", "political"]), "area");
	assert.equal(placeKind(undefined), "address");
});

test("TtlCache expires entries and evicts the oldest when full; InFlight shares one call", async () => {
	let now = 0;
	const cache = new TtlCache<number>(1000, 2, () => now);
	cache.set("a", 1);
	cache.set("b", 2);
	cache.set("c", 3);
	assert.equal(cache.get("a"), undefined, "oldest evicted");
	assert.equal(cache.get("b"), 2);
	now = 1000;
	assert.equal(cache.get("b"), undefined, "expired");
	const inFlight = new InFlight<number>();
	let calls = 0;
	let release: () => void = () => undefined;
	const slow = () =>
		new Promise<number>((resolve) => {
			calls++;
			release = () => resolve(calls);
		});
	const first = inFlight.run("k", slow);
	const second = inFlight.run("k", slow);
	release();
	const [x, y] = await Promise.all([first, second]);
	assert.equal(calls, 1);
	assert.equal(x, y);
	const third = inFlight.run("k", slow);
	release();
	await third;
	assert.equal(calls, 2, "nothing is kept once settled");
});

const fakeTransport = () => {
	const sent: (HttpRequest & { apiKey: string })[] = [];
	const transport = async (request: HttpRequest & { apiKey: string }) => {
		sent.push(request);
		if (request.url.startsWith(AUTOCOMPLETE_URL)) return { status: 200, data: fixture("autocomplete") };
		if (request.url.includes("/v1/places/")) return { status: 200, data: fixture("details-hotel") };
		return { status: 200, data: fixture("geocode-ok") };
	};
	return { sent, transport };
};

test("client: one session token across autocomplete and details; the key is only given to the transport", async () => {
	const { sent, transport } = fakeTransport();
	const client = createPlacesClient({ apiKey: () => "server-key", transport });
	await client.autocomplete("user-1", { input: "sav", sessionToken: TOKEN });
	await client.autocomplete("user-1", { input: "savo", sessionToken: TOKEN });
	const place = await client.placeDetails("user-1", "ChIJdd4hrwug2EcRmSrV3Vo6llI", TOKEN);
	assert.equal(place.name, "The Savoy");
	assert.equal(sent.length, 3);
	assert.ok(sent.every((r) => r.apiKey === "server-key"));
	assert.equal((sent[0].body as any).sessionToken, TOKEN);
	assert.equal((sent[1].body as any).sessionToken, TOKEN);
	assert.ok(sent[2].url.includes(`sessionToken=${TOKEN}`), "details close the same session");
	assert.ok(
		sent.every((r) => !JSON.stringify(r.headers).includes("server-key")),
		"not in built headers",
	);
});

test("client cache: a selected place is reused only for the same person and session (no cross-user content)", async () => {
	let now = 0;
	const { sent, transport } = fakeTransport();
	const client = createPlacesClient({ apiKey: () => "k", transport, now: () => now });
	await client.placeDetails("user-1", "ChIJdd4hrwug2EcRmSrV3Vo6llI", TOKEN);
	await client.placeDetails("user-1", "ChIJdd4hrwug2EcRmSrV3Vo6llI", TOKEN);
	assert.equal(sent.length, 1, "a double tap is billed once");
	await client.placeDetails("user-2", "ChIJdd4hrwug2EcRmSrV3Vo6llI", TOKEN);
	assert.equal(sent.length, 2, "another person always gets a fresh call");
	await client.placeDetails("user-1", "ChIJdd4hrwug2EcRmSrV3Vo6llI", "another-session-token-1234");
	assert.equal(sent.length, 3, "another session gets a fresh call");
	now = DETAILS_CACHE_TTL_MS;
	await client.placeDetails("user-1", "ChIJdd4hrwug2EcRmSrV3Vo6llI", TOKEN);
	assert.equal(sent.length, 4, "expired");
	// Autocomplete results are never cached (Google's terms); repeated text is fetched again.
	await client.autocomplete("user-1", { input: "sav", sessionToken: TOKEN });
	await client.autocomplete("user-1", { input: "sav", sessionToken: TOKEN });
	assert.equal(sent.length, 6);
});

test("client without a key: places_not_configured and nothing is sent", async () => {
	const { sent, transport } = fakeTransport();
	const client = createPlacesClient({ apiKey: () => "", transport });
	assert.equal(client.configured, false);
	await assert.rejects(
		client.autocomplete("u", { input: "x", sessionToken: TOKEN }),
		(e: any) => e.code === "places_not_configured" && e.status === 503,
	);
	await assert.rejects(client.placeDetails("u", "ChIJdd4hrwug2EcRmSrV3Vo6llI"), (e: any) => e.status === 503);
	await assert.rejects(client.reverseGeocode({ latitude: 1, longitude: 1 }), (e: any) => e.status === 503);
	assert.equal(sent.length, 0);
});

test("client: Google errors become typed errors", async () => {
	const client = createPlacesClient({
		apiKey: () => "k",
		transport: async () => ({ status: 403, data: fixture("places-error-403") }),
	});
	await assert.rejects(
		client.autocomplete("u", { input: "x", sessionToken: TOKEN }),
		(e: any) => e instanceof PlacesError && e.code === "places_unavailable",
	);
});

test("booking address: unchanged without picker fields; custom text is what people see, pin coordinates kept", () => {
	assert.deepEqual(bookingAddressFields({ address: "1 Main St", latitude: 1, longitude: 2 }), {
		address: "1 Main St",
		location: null,
	});
	const picked = bookingAddressFields({
		address: "Strand, London WC2R 0EZ, UK",
		placeId: "ChIJdd4hrwug2EcRmSrV3Vo6llI",
		formattedAddress: "Strand, London WC2R 0EZ, UK",
		placeName: "The Savoy",
		locationSource: "search",
		customAddress: "  The Savoy, staff entrance,  Savoy Court ",
	});
	assert.equal(picked.address, "The Savoy, staff entrance, Savoy Court");
	assert.deepEqual(picked.location, {
		placeId: "ChIJdd4hrwug2EcRmSrV3Vo6llI",
		formattedAddress: "Strand, London WC2R 0EZ, UK",
		placeName: "The Savoy",
		source: "search",
		customAddress: "The Savoy, staff entrance, Savoy Court",
		submittedAddress: "Strand, London WC2R 0EZ, UK",
	});
	const mapOnly = bookingAddressFields({ address: "Pinned", locationSource: "map", customAddress: "" });
	assert.deepEqual(mapOnly, { address: "Pinned", location: { source: "map" } });
	assert.equal(bookingDisplayAddress({ address: "x", location: { customAddress: "Custom" } }), "Custom");
	assert.equal(bookingDisplayAddress({ address: "Old booking" }), "Old booking");
});
