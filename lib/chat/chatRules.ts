// The chat rules as pure functions (tests/chat.test.ts). Who may talk to whom, who may get a chat session, how the
// CometChat webhook is authenticated, which attachments are allowed, who may be blocked or reported, and when a new
// message is pushed. lib/chat/chatSync.ts and the controllers apply them.
import crypto from "crypto";
import type { ChatMessage } from "./cometchat";

type Id = { toString(): string };

export interface BookingForChat {
	_id: Id;
	status: "pending" | "in progress" | "completed" | "cancelled" | string;
	userId: Id;
	providerId?: Id | null;
	acceptedAt?: Date | null;
	completedAt?: Date | null;
	cancelledAt?: Date | null;
	updatedAt?: Date | null;
}

export interface ChatWindow {
	open: boolean;
	/** When the window closes; null while the booking is still active (no end yet) or when it never opened. */
	until: Date | null;
	reason: "active" | "grace" | "ended" | "unassigned";
}

/**
 * One booking's chat window: from the moment a provider accepted it (the provider is on the booking) until `graceMs`
 * after it was completed or cancelled. An unassigned booking (open, released back to open, expired) opens nothing.
 */
export const bookingChatWindow = (booking: BookingForChat, now: Date, graceMs: number): ChatWindow => {
	if (!booking.providerId) return { open: false, until: null, reason: "unassigned" };
	if (booking.status === "pending" || booking.status === "in progress") {
		return { open: true, until: null, reason: "active" };
	}
	const endedAt =
		booking.status === "completed"
			? (booking.completedAt ?? booking.updatedAt)
			: booking.status === "cancelled"
				? (booking.cancelledAt ?? booking.updatedAt)
				: null;
	if (!endedAt) return { open: false, until: null, reason: "ended" };
	const until = new Date(new Date(endedAt).getTime() + graceMs);
	return until.getTime() > now.getTime()
		? { open: true, until, reason: "grace" }
		: { open: false, until, reason: "ended" };
};

export interface PairState {
	allowed: boolean;
	/** When the pair stops being allowed if nothing changes; null while a booking is active or when not allowed. */
	until: Date | null;
	/** The bookings that currently allow it. */
	bookingIds: string[];
}

/** A customer and a provider may chat while any booking they share is in its window. */
export const pairChatState = (bookings: BookingForChat[], now: Date, graceMs: number): PairState => {
	let allowed = false;
	let openEnded = false;
	let until: Date | null = null;
	const bookingIds: string[] = [];
	for (const booking of bookings) {
		const window = bookingChatWindow(booking, now, graceMs);
		if (!window.open) continue;
		allowed = true;
		bookingIds.push(String(booking._id));
		if (window.until === null) openEnded = true;
		else if (!until || window.until > until) until = window.until;
	}
	return { allowed, until: allowed && !openEnded ? until : null, bookingIds };
};

/**
 * The shared demo accounts (their passwords are published) may chat with each other only, under the same booking
 * rule as everyone else, so a stranger signed in as a demo account can never reach a real person by chat.
 */
export const demoPairPolicy = (customerIsDemo: boolean, providerIsDemo: boolean): "never" | "bookings" =>
	customerIsDemo !== providerIsDemo ? "never" : "bookings";

export const decidePair = (
	bookings: BookingForChat[],
	people: { customerIsDemo: boolean; providerIsDemo: boolean },
	now: Date,
	graceMs: number,
): PairState => {
	if (demoPairPolicy(people.customerIsDemo, people.providerIsDemo) === "never") {
		return { allowed: false, until: null, bookingIds: [] };
	}
	return pairChatState(bookings, now, graceMs);
};

export interface ChatRefusal {
	status: number;
	code: string;
	message: string;
}

/** Why a user may not get a chat session, or null when they may. */
export const chatSessionRefusal = (user: {
	isEmailVerified?: boolean | null;
	suspended?: boolean | null;
	chatSuspended?: boolean | null;
}): ChatRefusal | null => {
	if (user.suspended) return { status: 403, code: "account_suspended", message: "This account is suspended." };
	if (!user.isEmailVerified)
		return { status: 403, code: "chat_email_unverified", message: "Verify your email address to use chat." };
	if (user.chatSuspended)
		return {
			status: 403,
			code: "chat_suspended",
			message: "Chat is turned off for this account. Contact HelpHive support.",
		};
	return null;
};

const sha = (value: string) => crypto.createHash("sha256").update(value).digest();

/**
 * CometChat webhooks authenticate with HTTP Basic auth (their only mechanism). Both parts are compared in constant
 * time (hashed first, so length differences do not leak either).
 */
export const verifyBasicAuth = (header: unknown, username: string, password: string): boolean => {
	if (!username || !password || typeof header !== "string" || !header.startsWith("Basic ")) return false;
	let decoded: string;
	try {
		decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
	} catch {
		return false;
	}
	const separator = decoded.indexOf(":");
	if (separator < 0) return false;
	const user = crypto.timingSafeEqual(sha(decoded.slice(0, separator)), sha(username));
	const pass = crypto.timingSafeEqual(sha(decoded.slice(separator + 1)), sha(password));
	return user && pass;
};

export interface AttachmentPolicy {
	maxBytes: number;
	types: readonly string[];
}

/** Why a message's attachments break the policy, or null when they are fine (or there are none). */
export const attachmentViolation = (
	message: Pick<ChatMessage, "type" | "attachments">,
	policy: AttachmentPolicy,
): "type" | "size" | "unknown" | null => {
	const media = ["image", "file", "audio", "video"].includes(message.type);
	if (!media && !message.attachments.length) return null;
	if (media && !message.attachments.length) return "unknown";
	for (const attachment of message.attachments) {
		if (!attachment.mimeType || !policy.types.includes(attachment.mimeType)) return "type";
		if (attachment.size === null) return "unknown";
		if (attachment.size > policy.maxBytes) return "size";
	}
	return null;
};

/**
 * What a message event is recorded as: counts and kinds, never the text or attachment links (a reported message is
 * the only one whose text is kept, in its report).
 */
export const messageMetadata = (message: ChatMessage) => ({
	messageId: message.id,
	receiverType: message.receiverType,
	category: message.category,
	type: message.type,
	textLength: message.text ? message.text.length : 0,
	attachments: message.attachments.length,
	attachmentTypes: [...new Set(message.attachments.map((a) => a.mimeType ?? "unknown"))],
	attachmentBytes: message.attachments.reduce((sum, a) => sum + (a.size ?? 0), 0),
});

export const REPORT_CATEGORIES = ["harassment", "spam", "inappropriate", "safety", "fraud", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * Whether `self` may block or report `target`: never themselves, and only someone they share (or shared) a booking
 * relationship with, which is everyone chat lets them reach. Demo accounts only reach each other.
 */
export const counterpartyDecision = (input: {
	selfId: string;
	targetId: string;
	related: boolean;
}): "ok" | "self" | "not_counterparty" => {
	if (input.selfId === input.targetId) return "self";
	return input.related ? "ok" : "not_counterparty";
};

/** A report about a message must be about a message the reported user sent to the reporter. */
export const reportedMessageMatches = (message: ChatMessage | null, reporterId: string, reportedId: string) =>
	!!message && message.sender === reportedId && message.receiverType === "user" && message.receiver === reporterId;

/**
 * Whether a new message is pushed to the receiver: only for a one-to-one conversation the two may still have, never
 * across a block or to a suspended person, not while the receiver has that conversation open, not for a removed
 * message, and not again for the same conversation within the burst interval.
 */
export const shouldPushChatMessage = (input: {
	enabled: boolean;
	receiverType: string;
	allowed: boolean;
	viewingConversation: boolean;
	recentlyPushed: boolean;
	blockedEitherWay: boolean;
	receiverChatSuspended: boolean;
	removed: boolean;
}) =>
	input.enabled &&
	input.receiverType === "user" &&
	input.allowed &&
	!input.viewingConversation &&
	!input.recentlyPushed &&
	!input.blockedEitherWay &&
	!input.receiverChatSuspended &&
	!input.removed;

/**
 * Deduplication key for a webhook delivery (CometChat sends no delivery id), so a retried message is recorded and
 * pushed once. Block and unblock carry no id and are idempotent to apply, so they are not deduplicated (a block, an
 * unblock and a second block of the same pair must all apply).
 */
export const webhookEventKey = (trigger: string, data: any): string | null => {
	if (trigger !== "message_sent") return null;
	const id = data?.message?.id;
	return typeof id === "string" || typeof id === "number" ? `${trigger}:${id}` : null;
};
