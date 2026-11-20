// Whether a chat message is a booking event this server sent itself (not a person's message that looks like one).
// The decision is verifyBookingEventAuthorship (lib/chat/bookingEvents.ts, pure); this loads the booking it needs.
// Only a genuine event is exempt from push, from the message statistics and from reporting.
import BookingModel from "../../dal/models/booking.model";
import { verifyBookingEventAuthorship } from "./bookingEvents";
import type { ChatMessage } from "./cometchat";
import log from "../logger";

export const isGenuineBookingEvent = async (
	message: Pick<ChatMessage, "sender" | "receiver" | "sentAt" | "bookingEvent">,
): Promise<boolean> => {
	if (!message.bookingEvent) return false;
	try {
		const booking = await BookingModel.findById(message.bookingEvent.bookingId)
			.select("userId providerId +chatEvents")
			.lean()
			.exec();
		return (
			verifyBookingEventAuthorship({
				message: {
					sender: message.sender,
					receiver: message.receiver,
					sentAtMs: message.sentAt === null ? null : message.sentAt * 1000,
					claim: message.bookingEvent,
				},
				booking: booking as any,
			}) === "genuine"
		);
	} catch (error) {
		// When it cannot be checked, it is a person's message: pushed, counted and reportable.
		log.warn("Could not check who sent a booking event message", {
			code: error instanceof Error ? error.name : "unknown",
		});
		return false;
	}
};
