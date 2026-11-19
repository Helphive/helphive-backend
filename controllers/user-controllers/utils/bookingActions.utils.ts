// Booking transitions shared by the apps (auth.controller.ts) and the operations console (controllers/admin), so a
// cancellation or completion does the same thing whoever asks: one atomic state change, the business event, the
// notifications, and (for completion) the provider's earning with its release task.
import type { Request } from "express";
import type mongoose from "mongoose";
import BookingModel from "../../../dal/models/booking.model";
import EarningModel from "../../../dal/models/earning.model";
import { createGoogleCloudTaskPaymentTrigger, sendBookingCancelledNotification } from "./auth.utils";
import { sendBookingCompletedNotification } from "./auth.utils";
import { emitEvent } from "../../../lib/events";
import type { ActorType } from "../../../lib/requestContext";
import { PROVIDER_SHARE } from "../../../lib/operations";

type Id = mongoose.Types.ObjectId | string;
type BookingDoc = InstanceType<typeof BookingModel>;

export interface CancelInput {
	bookingId: Id;
	/** The status the booking must still have: "pending" for the apps, "in progress" only for an admin resolution. */
	fromStatus?: "pending" | "in progress";
	/** Stored as cancelledBy: the customer or provider the cancellation is for. */
	cancelledBy: Id;
	by: "customer" | "provider" | "admin";
	actor: { type: ActorType; id?: Id };
	/** Extra event properties (onBehalfOf for an admin). */
	properties?: Record<string, unknown>;
	req?: Request;
}

/**
 * Cancels a booking if it still has `fromStatus` (atomic: a double tap or two parties at once cancel it once), records
 * the event and notifies both parties. Returns the cancelled booking, or null when it was no longer in that status.
 * Refunding is the caller's next step (refundPaymentIfPaid), exactly as before.
 */
export const cancelBookingTransition = async (input: CancelInput): Promise<BookingDoc | null> => {
	const cancelled = await BookingModel.findOneAndUpdate(
		{ _id: input.bookingId, status: input.fromStatus ?? "pending" },
		{ $set: { status: "cancelled", cancelledAt: new Date(), cancelledBy: input.cancelledBy } },
		{ new: true },
	).exec();
	if (!cancelled) return null;

	emitEvent(
		{
			type: "booking.cancelled",
			actor: input.actor,
			subjects: { userId: cancelled.userId, providerId: cancelled.providerId, bookingId: cancelled._id },
			properties: {
				by: input.by,
				reason: cancelled.cancellationReason ?? null,
				wasAccepted: !!cancelled.providerId,
				...input.properties,
			},
		},
		input.req,
	);

	await sendBookingCancelledNotification(
		cancelled.userId.toString(),
		cancelled.providerId ? cancelled.providerId.toString() : "",
		cancelled,
	);
	return cancelled;
};

export interface CompleteInput {
	booking: BookingDoc;
	/** The paid amount the earning is a share of. */
	paymentAmount: number;
	/** Stored as completedBy: the customer or provider, or null when an admin completed it. */
	completedBy: Id | null;
	by: "customer" | "provider" | "admin";
	actor: { type: ActorType; id?: Id };
	req?: Request;
}

export interface CompleteResult {
	completed: BookingDoc;
	earning: InstanceType<typeof EarningModel>;
	releaseAt: Date;
}

/**
 * Completes an in-progress booking (atomic), creates the provider's earning and schedules its release, records the
 * events and notifies both parties. Returns null when the booking was no longer in progress. If the earning or its
 * release task cannot be created, the booking is put back in progress and the error is thrown, so it can be retried.
 */
export const completeBookingTransition = async (input: CompleteInput): Promise<CompleteResult | null> => {
	const { booking } = input;
	const completed = await BookingModel.findOneAndUpdate(
		{ _id: booking._id, status: "in progress" },
		{ $set: { status: "completed", completedAt: new Date(), completedBy: input.completedBy } },
		{ new: true },
	).exec();
	if (!completed) return null;

	let earning: InstanceType<typeof EarningModel> | null = null;
	let releaseAt: Date;
	try {
		earning = await EarningModel.create({
			bookingId: booking._id,
			amount: input.paymentAmount * PROVIDER_SHARE,
			date: new Date(),
		});
		// REQUIRES ATTENTION: earnings are released 30 seconds after completion (meant to be several days).
		releaseAt = new Date(Date.now() + 30 * 1000);
		await createGoogleCloudTaskPaymentTrigger(String(booking._id), releaseAt);
	} catch (error) {
		// Without its release task the earning would never be paid; put the booking back so it can be retried.
		await BookingModel.updateOne(
			{ _id: booking._id, status: "completed" },
			{ $set: { status: "in progress", completedAt: null, completedBy: null } },
		);
		if (earning) await EarningModel.deleteOne({ _id: earning._id });
		throw error;
	}

	const subjects = { userId: booking.userId, providerId: booking.providerId, bookingId: booking._id };
	emitEvent(
		{
			type: "booking.completed",
			actor: input.actor,
			subjects,
			properties: {
				by: input.by,
				durationMs: completed.startedAt
					? completed.completedAt.getTime() - completed.startedAt.getTime()
					: null,
				bookedHours: completed.hours,
			},
		},
		input.req,
	);
	emitEvent(
		{
			type: "earning.created",
			actor: { type: "system" },
			subjects: { ...subjects, earningId: earning._id },
			properties: { amount: earning.amount, releaseAt },
		},
		input.req,
	);

	await sendBookingCompletedNotification(
		booking.userId.toString(),
		(booking.providerId as mongoose.Types.ObjectId).toString(),
		completed,
	);
	return { completed, earning, releaseAt };
};
