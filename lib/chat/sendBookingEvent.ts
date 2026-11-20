// Sends a booking event to the chat of the booking's customer and provider (lib/chat/bookingEvents.ts has the rules).
// At most once per (booking, event): the event is claimed on the booking record before it is sent. Never throws, and
// logs only the event name and an error code (no names, ids of people, or message text).
import mongoose from "mongoose";
import BookingModel from "../../dal/models/booking.model";
import UserModel from "../../dal/models/user.model";
import { chatConfig } from "../../config/chat";
import { isDemoAccountEmail } from "../../config/demoAccounts";
import { CometChatError, cometChat, type CometChatClient } from "./cometchat";
import { decidePair } from "./chatRules";
import {
	bookingEventClaimPath,
	bookingEventMetadata,
	bookingEventSender,
	BOOKING_EVENT_TEXT,
	shouldSendBookingEvent,
	type BookingEvent,
} from "./bookingEvents";
import log from "../logger";

type Id = mongoose.Types.ObjectId | string;

export type BookingEventOutcome = SendDecisionOutcome | "not_configured" | "already_sent" | "sent" | "failed";
type SendDecisionOutcome = "no_provider" | "wrong_status" | "chat_closed" | "not_found";

export interface SendBookingEventOptions {
	/** Who did it (the customer or provider); null or anyone else (an admin, an automatic change) sends as the customer. */
	actorId?: Id | null;
	client?: CometChatClient;
	now?: Date;
}

/** The booking's event message, once. Resolves with what happened; never rejects. */
export const sendBookingEvent = async (
	bookingId: Id,
	event: BookingEvent,
	options: SendBookingEventOptions = {},
): Promise<BookingEventOutcome> => {
	const client = options.client ?? cometChat;
	try {
		if (!client.configured) return "not_configured";
		const now = options.now ?? new Date();
		const booking = await BookingModel.findById(bookingId)
			.select("status userId providerId acceptedAt completedAt cancelledAt updatedAt")
			.lean()
			.exec();
		if (!booking) return "not_found";
		if (!booking.providerId) return "no_provider";

		const [customer, provider, pairBookings] = await Promise.all([
			UserModel.findById(booking.userId).select("email").lean().exec(),
			UserModel.findById(booking.providerId).select("email").lean().exec(),
			BookingModel.find({ userId: booking.userId, providerId: booking.providerId })
				.select("status userId providerId acceptedAt completedAt cancelledAt updatedAt")
				.lean()
				.exec(),
		]);
		const pair = decidePair(
			pairBookings as any[],
			{
				customerIsDemo: isDemoAccountEmail(customer?.email),
				providerIsDemo: isDemoAccountEmail(provider?.email),
			},
			now,
			chatConfig().graceMs,
		);
		const decision = !customer || !provider ? "chat_closed" : shouldSendBookingEvent(event, booking, pair);
		if (decision !== "send") return decision;

		// Claim first, atomically: a retry, a double tap or a replayed webhook finds it claimed and sends nothing.
		const path = bookingEventClaimPath(event);
		const claimed = await BookingModel.updateOne(
			{ _id: booking._id, [path]: null },
			{ $set: { [path]: now } },
		).exec();
		if (claimed.modifiedCount !== 1) return "already_sent";

		const { from, to } = bookingEventSender(event, {
			customerId: booking.userId,
			providerId: booking.providerId,
			actorId: options.actorId,
		});
		try {
			await client.sendText(from, to, BOOKING_EVENT_TEXT[event], bookingEventMetadata(event, booking._id as any));
		} catch (error) {
			log.error("Could not send a booking event to the chat", {
				event,
				status: error instanceof CometChatError ? error.status : null,
				code: error instanceof CometChatError ? error.code : error instanceof Error ? error.name : "unknown",
			});
			return "failed";
		}
		return "sent";
	} catch (error) {
		log.error("Could not send a booking event to the chat", {
			event,
			code: error instanceof Error ? error.name : "unknown",
		});
		return "failed";
	}
};

/** How long a booking action waits for the chat before it carries on (the send itself keeps going). */
export const BOOKING_EVENT_WAIT_MS = 2500;

/**
 * For the booking actions: sends the event but never holds the action up for longer than BOOKING_EVENT_WAIT_MS (the
 * send is awaited so the work is not cut off when the response ends, but a slow CometChat does not slow the action).
 */
export const notifyBookingEvent = async (
	bookingId: Id,
	event: BookingEvent,
	options: SendBookingEventOptions = {},
	waitMs = BOOKING_EVENT_WAIT_MS,
): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, waitMs);
		timer.unref?.();
	});
	try {
		await Promise.race([sendBookingEvent(bookingId, event, options).then(() => undefined), limit]);
	} finally {
		clearTimeout(timer);
	}
};
