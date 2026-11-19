// Redaction shared by the logger, the audit log and the event stream. Data leaving the request path (logs, audit
// summaries, event properties) goes through here so secrets, document links and full email addresses never land in it.
import crypto from "crypto";

export const REDACTED = "[redacted]";
export const REDACTED_URL = "[url]";

// Keys whose values are never kept, matched case-insensitively against the whole key or its last segment.
const SECRET_KEY =
	/(^|_|-)(password|passwd|secret|token|accesstoken|refreshtoken|clientsecret|authorization|cookie|otp|totp|code|codes|recoverycodes|hash|apikey|api_key|privatekey|signature|challengetoken|sessiontoken)$/i;
const SECRET_KEY_CONTAINS = /(password|secret|token|authorization|cookie|recovery|apikey|privatekey)/i;

/** Whether a property name holds a credential and its value must be dropped. */
export const isSecretKey = (key: string) => SECRET_KEY.test(key) || SECRET_KEY_CONTAINS.test(key);

const URL_LIKE = /^(https?:\/\/|gs:\/\/|s3:\/\/)/i;
const EMAIL = /([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** "jane.doe@example.com" -> "j***@example.com". The domain stays: it is what deliverability and fraud work need. */
export const maskEmail = (email: string) => email.replace(EMAIL, (_m, first, _rest, domain) => `${first}***@${domain}`);

/** Masks every email address inside free text. */
export const maskEmailsIn = (text: string) =>
	text.replace(EMAIL, (_m, first, _rest, domain) => `${first}***@${domain}`);

/** Stable keyed hash of an email (lower-cased, trimmed), to correlate attempts without storing the address. */
export const hashEmail = (
	email: string,
	secret = process.env.RATE_LIMIT_HASH_SECRET || process.env.ACCESS_TOKEN_SECRET,
) =>
	crypto
		.createHmac("sha256", secret || "helphive-email-hash")
		.update(email.trim().toLowerCase())
		.digest("hex")
		.slice(0, 32);

export interface RedactOptions {
	/** Keys whose values are document paths or links (e.g. a provider application's id, dbs, resume, profile). */
	documentKeys?: readonly string[];
	/** Mask email addresses in string values (default true). */
	maskEmails?: boolean;
	maxDepth?: number;
	maxStringLength?: number;
	maxArrayLength?: number;
}

/**
 * A copy of `value` safe to store or log: credential keys dropped to "[redacted]", URLs and document paths replaced,
 * emails masked, long strings and arrays truncated, depth bounded. ObjectIds and Dates become strings.
 */
export const redact = (value: unknown, options: RedactOptions = {}, depth = 0): unknown => {
	const { documentKeys = [], maskEmails = true, maxDepth = 6, maxStringLength = 1000, maxArrayLength = 50 } = options;
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		if (URL_LIKE.test(value)) return REDACTED_URL;
		const text = value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…` : value;
		return maskEmails ? maskEmailsIn(text) : text;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (typeof value === "function" || typeof value === "symbol") return undefined;
	// ObjectId and similar: anything with a meaningful toHexString.
	if (typeof (value as { toHexString?: unknown }).toHexString === "function") {
		return (value as { toHexString: () => string }).toHexString();
	}
	if (depth >= maxDepth) return "[truncated]";
	if (Array.isArray(value)) {
		const items = value.slice(0, maxArrayLength).map((item) => redact(item, options, depth + 1));
		if (value.length > maxArrayLength) items.push(`[+${value.length - maxArrayLength} more]`);
		return items;
	}
	if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
	const source =
		typeof (value as { toObject?: unknown }).toObject === "function"
			? (value as { toObject: () => Record<string, unknown> }).toObject()
			: (value as Record<string, unknown>);
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(source)) {
		if (item === undefined) continue;
		if (isSecretKey(key)) out[key] = REDACTED;
		else if (documentKeys.includes(key)) out[key] = item ? "[document]" : item;
		else out[key] = redact(item, options, depth + 1);
	}
	return out;
};
