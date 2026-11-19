// Notifications centre, the pure part: segments and the database filter for each, who is never contacted, template
// placeholders, push batching and the idempotency decision for a send. The controller
// (controllers/admin/notifications.controller.ts) runs the queries and the sends; tests/notifications.test.ts covers
// these rules.
import crypto from "crypto";
import { isDemoAccountEmail } from "../config/demoAccounts";

export const SEGMENT_TYPES = [
	"all_customers",
	"all_providers",
	"providers_with_service",
	"booked_in_range",
	"one_person",
] as const;
export type SegmentType = (typeof SEGMENT_TYPES)[number];

export const CHANNELS = ["push", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Segment {
	type: SegmentType;
	/** providers_with_service: the service id (1, 2 or 3). */
	serviceId?: number;
	/** booked_in_range: bookings starting in [from, to). */
	from?: string;
	to?: string;
	/** booked_in_range: customers, providers or both of those bookings. */
	party?: "customers" | "providers" | "both";
	/** providers: only approved providers (default true). */
	approvedOnly?: boolean;
	/** one_person */
	userId?: string;
}

/** Most recipients one send reaches; email is slower (the provider's rate limit), so its cap is lower. */
export const MAX_PUSH_RECIPIENTS = 5000;
export const MAX_EMAIL_RECIPIENTS = 300;
export const MAX_BOOKING_RANGE_DAYS = 92;

export type SegmentCheck = { ok: true; segment: Segment } | { ok: false; message: string };

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** Validates a segment from the request body into its canonical form. */
export const parseSegment = (value: unknown): SegmentCheck => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { ok: false, message: "Choose an audience." };
	const v = value as Record<string, unknown>;
	const type = v.type as SegmentType;
	if (!SEGMENT_TYPES.includes(type))
		return { ok: false, message: `audience type must be one of: ${SEGMENT_TYPES.join(", ")}.` };
	switch (type) {
		case "all_customers":
			return { ok: true, segment: { type } };
		case "all_providers":
			return { ok: true, segment: { type, approvedOnly: v.approvedOnly !== false } };
		case "providers_with_service": {
			const serviceId = Number(v.serviceId);
			if (![1, 2, 3].includes(serviceId)) return { ok: false, message: "Choose the service (1, 2 or 3)." };
			return { ok: true, segment: { type, serviceId, approvedOnly: v.approvedOnly !== false } };
		}
		case "booked_in_range": {
			const from = typeof v.from === "string" ? Date.parse(v.from) : NaN;
			const to = typeof v.to === "string" ? Date.parse(v.to) : NaN;
			if (Number.isNaN(from) || Number.isNaN(to))
				return { ok: false, message: "Give the booking date range (from and to)." };
			if (from >= to) return { ok: false, message: "from must be before to." };
			if (to - from > MAX_BOOKING_RANGE_DAYS * 86_400_000)
				return { ok: false, message: `The booking range can be at most ${MAX_BOOKING_RANGE_DAYS} days.` };
			const party = (v.party ?? "customers") as Segment["party"];
			if (!["customers", "providers", "both"].includes(party as string))
				return { ok: false, message: "party must be customers, providers or both." };
			return {
				ok: true,
				segment: { type, from: new Date(from).toISOString(), to: new Date(to).toISOString(), party },
			};
		}
		case "one_person":
			if (typeof v.userId !== "string" || !OBJECT_ID.test(v.userId))
				return { ok: false, message: "Choose the person." };
			return { ok: true, segment: { type, userId: v.userId } };
	}
};

/**
 * The user filter for a segment. For booked_in_range the caller first finds the people with such bookings and passes
 * their ids. Suspended accounts are always left out here; demo accounts and email policy refusals are left out per
 * recipient (recipientExclusion), since they depend on the email address and the channel.
 */
export const segmentUserFilter = (segment: Segment, bookedUserIds?: string[]): Record<string, unknown> => {
	const base = { suspended: { $ne: true } };
	const provider = (approvedOnly?: boolean) => ({
		"roles.Provider": true,
		...(approvedOnly !== false ? { providerStatus: "approved" } : {}),
	});
	switch (segment.type) {
		case "all_customers":
			return { ...base, "roles.Provider": { $ne: true } };
		case "all_providers":
			return { ...base, ...provider(segment.approvedOnly) };
		case "providers_with_service":
			return { ...base, ...provider(segment.approvedOnly), "selectedJobTypes.id": segment.serviceId };
		case "booked_in_range":
			return { ...base, _id: { $in: bookedUserIds ?? [] } };
		case "one_person":
			return { ...base, _id: segment.userId };
	}
};

/** The bookings filter for booked_in_range, and which ids of them are the audience. */
export const bookedInRangeQuery = (segment: Segment) => ({
	filter: { startDate: { $gte: new Date(segment.from!), $lt: new Date(segment.to!) } },
	fields:
		segment.party === "providers"
			? ["providerId"]
			: segment.party === "both"
				? ["userId", "providerId"]
				: ["userId"],
});

export interface Recipient {
	_id: string;
	email?: string | null;
	firstName?: string | null;
	lastName?: string | null;
	isProvider: boolean;
	suspended?: boolean;
	isEmailVerified?: boolean;
}

export type Exclusion = "suspended" | "demo_account" | "email_not_verified" | null;

/** Why a person is never contacted, whatever the channel (null when they may be). */
export const recipientExclusion = (r: Recipient): Exclusion => {
	if (r.suspended) return "suspended";
	if (isDemoAccountEmail(r.email)) return "demo_account";
	return null;
};

/** Email goes only to verified addresses (an unverified one may be a typo or someone else's); then the email policy decides. */
export const emailExclusion = (r: Recipient): Exclusion =>
	recipientExclusion(r) ?? (r.isEmailVerified ? null : "email_not_verified");

// ---------------------------------------------------------------------------------------------------------------
// Templates

export const PLACEHOLDERS = {
	firstName: "The person's first name",
	lastName: "The person's last name",
	role: "customer or provider",
	supportEmail: "The support address",
} as const;
export type Placeholder = keyof typeof PLACEHOLDERS;

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

/** Unknown placeholders in a text (shown as a validation error, never sent). */
export const unknownPlaceholders = (text: string) =>
	[...text.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]).filter((name) => !(name in PLACEHOLDERS));

export interface MessageTemplate {
	title: string;
	body: string;
	emailSubject?: string | null;
}

export const TEMPLATE_LIMITS = { title: 65, body: 1000, emailSubject: 120 } as const;

export const validateTemplate = (
	t: unknown,
	channels: Channel[],
): { ok: true; template: MessageTemplate } | { ok: false; message: string } => {
	if (!t || typeof t !== "object") return { ok: false, message: "Write the message." };
	const v = t as Record<string, unknown>;
	const title = typeof v.title === "string" ? v.title.trim() : "";
	const body = typeof v.body === "string" ? v.body.trim() : "";
	const emailSubject = typeof v.emailSubject === "string" && v.emailSubject.trim() ? v.emailSubject.trim() : null;
	if (!title || title.length > TEMPLATE_LIMITS.title)
		return { ok: false, message: `The title must be 1 to ${TEMPLATE_LIMITS.title} characters.` };
	if (!body || body.length > TEMPLATE_LIMITS.body)
		return { ok: false, message: `The message must be 1 to ${TEMPLATE_LIMITS.body} characters.` };
	if (emailSubject && emailSubject.length > TEMPLATE_LIMITS.emailSubject)
		return { ok: false, message: `The email subject must be at most ${TEMPLATE_LIMITS.emailSubject} characters.` };
	const unknown = unknownPlaceholders(`${title} ${body} ${emailSubject ?? ""}`);
	if (unknown.length)
		return {
			ok: false,
			message: `Unknown placeholder {{${unknown[0]}}}. Use ${Object.keys(PLACEHOLDERS)
				.map((p) => `{{${p}}}`)
				.join(", ")}.`,
		};
	if (!channels.length) return { ok: false, message: "Choose push, email or both." };
	return { ok: true, template: { title, body, emailSubject } };
};

/** The text with each placeholder filled for one person (a missing value becomes "there" for a first name, else empty). */
export const renderText = (
	text: string,
	r: Pick<Recipient, "firstName" | "lastName" | "isProvider">,
	supportEmail: string,
) =>
	text
		.replace(PLACEHOLDER_PATTERN, (_m, name: string) => {
			switch (name) {
				case "firstName":
					return r.firstName?.trim() || "there";
				case "lastName":
					return r.lastName?.trim() ?? "";
				case "role":
					return r.isProvider ? "provider" : "customer";
				case "supportEmail":
					return supportEmail;
				default:
					return "";
			}
		})
		.replace(/[ \t]{2,}/g, " ");

export const renderMessage = (t: MessageTemplate, r: Recipient, supportEmail: string) => ({
	title: renderText(t.title, r, supportEmail),
	body: renderText(t.body, r, supportEmail),
	emailSubject: renderText(t.emailSubject || t.title, r, supportEmail),
});

/** OneSignal takes at most this many external ids per request. */
export const PUSH_BATCH = 2000;

/** Push requests: recipients with the same rendered text share a request, in batches of PUSH_BATCH. */
export const pushBatches = (t: MessageTemplate, recipients: Recipient[], supportEmail: string) => {
	const groups = new Map<string, { title: string; body: string; ids: string[] }>();
	for (const r of recipients) {
		const { title, body } = renderMessage(t, r, supportEmail);
		const key = `${title}\u0000${body}`;
		const group = groups.get(key) ?? { title, body, ids: [] };
		group.ids.push(r._id);
		groups.set(key, group);
	}
	const batches: { title: string; body: string; ids: string[] }[] = [];
	for (const group of groups.values())
		for (let i = 0; i < group.ids.length; i += PUSH_BATCH)
			batches.push({ title: group.title, body: group.body, ids: group.ids.slice(i, i + PUSH_BATCH) });
	return batches;
};

// ---------------------------------------------------------------------------------------------------------------
// Idempotency

/** A stable hash of what a send asks for, so a reused key with a different request is refused. */
export const sendFingerprint = (input: { segment: Segment; channels: Channel[]; template: MessageTemplate }) =>
	crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				segment: input.segment,
				channels: [...input.channels].sort(),
				template: {
					title: input.template.title,
					body: input.template.body,
					emailSubject: input.template.emailSubject ?? null,
				},
			}),
		)
		.digest("hex");

export type SendDecision = "new" | "replay" | "in_progress" | "key_reused";

/** What to do with a send whose idempotency key already has a campaign (or none). */
export const decideSend = (
	existing: { fingerprint: string; status: string } | null,
	fingerprint: string,
): SendDecision => {
	if (!existing) return "new";
	if (existing.fingerprint !== fingerprint) return "key_reused";
	return existing.status === "sending" ? "in_progress" : "replay";
};
