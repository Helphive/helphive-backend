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
 * Whether a message is a system booking event: valid metadata AND exactly that event's fallback text. The text check
 * keeps the exemptions (no push, not reportable) from covering anything a person could write: a person who puts the
 * metadata on a message of their own can only get one of these four fixed sentences exempted.
 */
export const isBookingEventMessage = (text: string | null | undefined, metadata: unknown): boolean => {
	const parsed = parseBookingEventMetadata(metadata);
	return !!parsed && text === BOOKING_EVENT_TEXT[parsed.event];
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
