// Masking for the public demo admin. middleware/demoAdmin.ts runs every successful JSON response to a demo admin
// through maskForDemo(), so endpoints added later are masked without anyone remembering to. Masking is by field name
// (plus a few value patterns as a safety net); fields it does not know are left alone, so the console still shows
// real amounts, statuses, dates, service types and counts.
//
// Records of the shared demo customer and demo provider (config/demoAccounts.ts) are shown unmasked, except that
// document and photo links are always removed.

export const MASK = "•••";

export interface DemoMaskOptions {
	/** Emails whose records stay unmasked (the shared demo customer and provider). */
	exemptEmails: ReadonlySet<string>;
}

/** Field names compared case-insensitively with "_" and "-" removed. */
const keyOf = (key: string) => key.toLowerCase().replace(/[_-]/g, "");
const set = (...keys: string[]) => new Set(keys.map(keyOf));

const EMAIL_KEYS = set(
	"email",
	"byEmail",
	"actorEmail",
	"recipient",
	"recipientEmail",
	"customerEmail",
	"providerEmail",
);
const PHONE_KEYS = set("phone", "phoneNumber", "mobile", "tel", "telephone");
const STREET_KEYS = set(
	"street",
	"address",
	"addressLine1",
	"addressLine2",
	"line1",
	"line2",
	"postcode",
	"postalCode",
	"zip",
	"zipCode",
);
const COORDINATE_KEYS = set("latitude", "longitude", "lat", "lng", "lon");
const NETWORK_KEYS = set("ip", "lastIp", "remoteIp", "ipAddress", "clientIp", "deviceId", "userAgent", "lastUserAgent");
const PAYMENT_ID_KEYS = set(
	"paymentIntentId",
	"clientSecret",
	"refundId",
	"transferId",
	"stripeConnectedAccountId",
	"destinationAccount",
	"account",
	"payoutId",
	"chargeId",
	"customerId",
	"paymentMethod",
	"paymentMethodId",
	"last4",
	"messageId",
	"taskName",
	"eventId",
);
const TOKEN_KEY = /(token|secret|password|hash|apikey|otp|recovery|cookie|authorization|signature)/i;
const FREE_TEXT_KEYS = set(
	"reason",
	"rejectReason",
	"cancellationReason",
	"note",
	"notes",
	"comment",
	"comments",
	"description",
	"details",
	"message",
	"error",
	"body",
	"summary",
);
const LAST_NAME_KEYS = set("lastName", "surname", "familyName");
const FULL_NAME_KEYS = set("name", "fullName", "displayName", "customerName", "providerName", "applicantName");
// A bare "name" under these is a thing's name (a service, a job type), not a person's.
const NON_PERSON_PARENTS = set(
	"service",
	"services",
	"selectedJobTypes",
	"jobTypes",
	"jobType",
	"model",
	"task",
	"queue",
);
const DOCUMENT_KEYS = set(
	"profile",
	"photo",
	"avatar",
	"image",
	"picture",
	"dbs",
	"resume",
	"cv",
	"document",
	"documents",
	"url",
	"signedUrl",
);

const EMAIL_VALUE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.([A-Za-z]{2,})/g;
const URL_VALUE = /^(https?:|gs:|s3:|data:)/i;
const DOCUMENT_PATH = /^[^\s/]+(\/[^\s/]+)+\.(jpe?g|png|webp|gif|heic|heif|pdf|docx?)$/i;
const STRIPE_ID = /^(pi|re|tr|po|acct|ch|cus|pm|seti|ba|card|evt|txn|src|py|in|sub|pyr)_[A-Za-z0-9_]{6,}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;

/** "jane.doe@example.co.uk" -> "j•••@•••.uk": first character and the top-level domain only. */
export const maskEmailForDemo = (email: string) =>
	email.replace(EMAIL_VALUE, (_m, first, tld) => `${first}${MASK}@${MASK}.${tld}`);

/** Keeps the last two digits: "+44 7700 900123" -> "•••23". */
export const maskPhone = (phone: string) => {
	const digits = phone.replace(/\D/g, "");
	return digits.length >= 2 ? `${MASK}${digits.slice(-2)}` : MASK;
};

/** "Doe" -> "D." */
export const lastInitial = (name: string) => {
	const trimmed = name.trim();
	return trimmed ? `${trimmed[0].toUpperCase()}.` : trimmed;
};

/** "Jane Mary Doe" -> "Jane D." (first name plus last initial). */
export const maskFullName = (name: string) => {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length < 2) return parts[0] ?? name;
	return `${parts[0]} ${lastInitial(parts[parts.length - 1])}`;
};

const roundCoordinate = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : value;

const isDocumentValue = (value: unknown) =>
	typeof value === "string" && (URL_VALUE.test(value) || DOCUMENT_PATH.test(value));

/** A string value that is identifying by itself, wherever it appears. */
const maskStringValue = (value: string) => {
	if (STRIPE_ID.test(value)) return MASK;
	if (IPV4.test(value) || (value.includes(":") && IPV6.test(value))) return MASK;
	return value.replace(EMAIL_VALUE, (_m, first, tld) => `${first}${MASK}@${MASK}.${tld}`);
};

const isExemptRecord = (value: Record<string, unknown>, options: DemoMaskOptions) =>
	typeof value.email === "string" && options.exemptEmails.has(value.email.trim().toLowerCase());

const MAX_DEPTH = 32;

const walk = (
	value: unknown,
	key: string | null,
	exempt: boolean,
	depth: number,
	options: DemoMaskOptions,
	parent: string | null = null,
): unknown => {
	if (value === null || value === undefined) return value;
	const k = key === null ? "" : keyOf(key);

	// Links to stored documents and photos never reach a demo admin, exempt record or not.
	if (isDocumentValue(value)) return null;
	if (k && DOCUMENT_KEYS.has(k) && typeof value === "string") return null;

	if (Array.isArray(value)) return value.map((item) => walk(item, key, exempt, depth + 1, options, parent));
	if (typeof value === "object") {
		if (depth > MAX_DEPTH) return null;
		const record = value as Record<string, unknown>;
		const exemptHere = exempt || isExemptRecord(record, options);
		const out: Record<string, unknown> = {};
		for (const [childKey, child] of Object.entries(record)) {
			// The top-level "message" of a response is the API talking, not someone's text.
			const effectiveKey = depth === 0 && keyOf(childKey) === "message" ? null : childKey;
			out[childKey] =
				effectiveKey === null ? child : walk(child, effectiveKey, exemptHere, depth + 1, options, key);
		}
		return out;
	}
	if (exempt) return value;

	if (COORDINATE_KEYS.has(k)) return roundCoordinate(value);
	if (typeof value !== "string") return value;
	if (TOKEN_KEY.test(k)) return MASK;
	if (EMAIL_KEYS.has(k)) return maskEmailForDemo(value);
	if (PHONE_KEYS.has(k)) return maskPhone(value);
	if (STREET_KEYS.has(k)) return MASK;
	if (NETWORK_KEYS.has(k)) return MASK;
	if (PAYMENT_ID_KEYS.has(k)) return MASK;
	if (FREE_TEXT_KEYS.has(k)) return value ? MASK : value;
	if (LAST_NAME_KEYS.has(k)) return lastInitial(value);
	if (FULL_NAME_KEYS.has(k) && !(k === "name" && parent !== null && NON_PERSON_PARENTS.has(keyOf(parent)))) {
		return maskFullName(value);
	}
	return maskStringValue(value);
};

/**
 * A masked copy of a response body. Mongoose documents, ObjectIds and Dates are first serialised exactly as res.json
 * would (toJSON), so the masked body has the same shape the client would otherwise receive.
 */
export const maskForDemo = (body: unknown, options: DemoMaskOptions): unknown => {
	if (body === undefined) return body;
	const plain = JSON.parse(JSON.stringify(body));
	return walk(plain, null, false, 0, options);
};
