// Booking events in the chat (accepted, started, completed, cancelled): the pure parts. A booking event is a normal
// CometChat text message whose fallback text an old app shows as it is, with metadata that newer clients render as a
// booking card. The contract for the apps is scratch/chat-cards/contract.md. lib/chat/sendBookingEvent.ts sends them.

export const BOOKING_EVENTS = ["accepted", "started", "completed", "cancelled"] as const;
export type BookingEvent = (typeof BOOKING_EVENTS)[number];

export const BOOKING_EVENT_VERSION = 1;

/** What an app without cards shows. `accepted` is byte for byte what the server has always sent. */
export const BOOKING_EVENT_TEXT: Record<BookingEvent, string> = {
	accepted: "A booking was accepted.",
	started: "The job has started.",
	completed: "The job was completed.",
	cancelled: "The booking was cancelled.",
};

type Id = { toString(): string } | string;

/** Only ids and the event name: no personal data, no booking details (clients load the booking themselves). */
export const bookingEventMetadata = (event: BookingEvent, bookingId: Id) => ({
	helphive: { v: BOOKING_EVENT_VERSION, kind: "booking_event" as const, event, bookingId: String(bookingId) },
});

const isEvent = (value: unknown): value is BookingEvent => (BOOKING_EVENTS as readonly unknown[]).includes(value);

/** The event a message's metadata describes, or null when it is not a booking event this server knows how to read. */
export const parseBookingEventMetadata = (metadata: unknown): { event: BookingEvent; bookingId: string } | null => {
	const helphive = (metadata as any)?.helphive;
	if (!helphive || helphive.kind !== "booking_event" || helphive.v !== BOOKING_EVENT_VERSION) return null;
	if (
		!isEvent(helphive.event) ||
		typeof helphive.bookingId !== "string" ||
		!/^[a-f\d]{24}$/i.test(helphive.bookingId)
	) {
		return null;
	}
	return { event: helphive.event, bookingId: helphive.bookingId };
};

/**
 * The event a message CLAIMS to be: valid metadata AND exactly that event's fixed sentence. This is only the shape:
 * anyone can send such a message through the CometChat SDK. Whether the server really sent it is
 * verifyBookingEventAuthorship below.
 */
export const claimedBookingEvent = (
	text: string | null | undefined,
	metadata: unknown,
): { event: BookingEvent; bookingId: string } | null => {
	const parsed = parseBookingEventMetadata(metadata);
	return parsed && text === BOOKING_EVENT_TEXT[parsed.event] ? parsed : null;
};

/**
 * The CometChat uid a booking event is sent as. `accepted` is always the customer (as it always was). The others are
 * sent as the person whose action it was; an admin or an automatic action (no actor, or not one of the two) is
 * the customer.
 */
export const bookingEventSender = (
	event: BookingEvent,
	people: { customerId: Id; providerId: Id; actorId?: Id | null },
): { from: string; to: string } => {
	const customer = String(people.customerId);
	const provider = String(people.providerId);
	const actor = people.actorId ? String(people.actorId) : null;
	const from = event === "accepted" ? customer : actor === provider ? provider : customer;
	return { from, to: from === customer ? provider : customer };
};

export interface BookingForEvent {
	status: string;
	providerId?: Id | null;
}

export type SendDecision = "send" | "no_provider" | "wrong_status" | "chat_closed";

/** The statuses a booking may have when each event is sent (a later change can already have happened). */
const STATUS_FOR: Record<BookingEvent, string[]> = {
	accepted: ["pending", "in progress", "completed"],
	started: ["in progress", "completed"],
	completed: ["completed"],
	cancelled: ["cancelled"],
};

/** Whether to send `event` now: the booking has a provider, is in a state the event can describe, the pair may chat. */
export const shouldSendBookingEvent = (
	event: BookingEvent,
	booking: BookingForEvent,
	pair: { allowed: boolean },
): SendDecision => {
	if (!booking.providerId) return "no_provider";
	if (!STATUS_FOR[event].includes(booking.status)) return "wrong_status";
	return pair.allowed ? "send" : "chat_closed";
};

/** The booking field that records the event was sent (claimed atomically before sending). */
export const bookingEventClaimPath = (event: BookingEvent) => `chatEvents.${event}`;

/** The message may be sent this long before the claim time (clock difference between this server and CometChat). */
export const EVENT_WINDOW_BEFORE_MS = 10_000;
/**
 * ... and this long after it. The send follows the claim within milliseconds (the CometChat call times out after 5 s);
 * two minutes leaves room for a slow call and CometChat's whole-second timestamps, and a replay later than that is
 * treated as a person's message.
 */
export const EVENT_WINDOW_AFTER_MS = 120_000;

export type Authorship = "genuine" | "not_an_event" | "other_pair" | "not_claimed" | "wrong_sender" | "outside_window";

type Claim = { at?: Date | string | null; from?: string | null } | null | undefined;

/**
 * Whether the server itself sent this message. What the message says proves nothing (any person can send the same
 * metadata and sentence), so this is decided from state the server owns: the named booking belongs to exactly this
 * sender and receiver, the server claimed that event on the booking, the sender is the one the sender rule gave the
 * claim, and the message was sent within a short window of the claim. Everything else is a person's message.
 */
export const verifyBookingEventAuthorship = (input: {
	/** From the message: who sent it to whom, when (ms), and the event it claims (claimedBookingEvent). */
	message: {
		sender: string;
		receiver: string;
		sentAtMs: number | null;
		claim: { event: BookingEvent; bookingId: string } | null;
	};
	/** The booking named by the message (null when it does not exist). `chatEvents` is the claim record. */
	booking: {
		_id: Id;
		userId: Id;
		providerId?: Id | null;
		chatEvents?: Partial<Record<BookingEvent, Claim>> | null;
	} | null;
}): Authorship => {
	const { message, booking } = input;
	if (!message.claim) return "not_an_event";
	if (!booking || String(booking._id) !== message.claim.bookingId || !booking.providerId) return "other_pair";
	const customer = String(booking.userId);
	const provider = String(booking.providerId);
	const pair = new Set([message.sender, message.receiver]);
	if (message.sender === message.receiver || !pair.has(customer) || !pair.has(provider)) return "other_pair";
	const claim = booking.chatEvents?.[message.claim.event];
	const claimedAt = claim?.at ? new Date(claim.at).getTime() : NaN;
	if (!claim || !Number.isFinite(claimedAt) || !claim.from) return "not_claimed";
	const expected = bookingEventSender(message.claim.event, {
		customerId: customer,
		providerId: provider,
		actorId: claim.from,
	}).from;
	if (message.sender !== expected) return "wrong_sender";
	const gap = message.sentAtMs === null ? NaN : message.sentAtMs - claimedAt;
	if (!(gap >= -EVENT_WINDOW_BEFORE_MS && gap <= EVENT_WINDOW_AFTER_MS)) return "outside_window";
	return "genuine";
};
