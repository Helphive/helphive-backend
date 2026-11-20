// No-show rule: a booking a provider accepted but never asked to start is cancelled and refunded once its shift has
// ended (start plus booked hours) and a grace period has passed. Before this rule such a booking stayed "accepted" for
// ever, with the customer's payment held. Pure parts; the Cloud Task that applies it is handleGoogleCloudTasksBookingNoShow
// (controllers/webhook-controllers/cloudtasks.controller.ts), scheduled when a provider accepts.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Stored as the booking's cancellationReason (the apps and the console may show it as it is). cancelledBy stays empty:
 * neither person cancelled, so the cancellation counts against nobody.
 */
export const NO_SHOW_CANCELLATION_REASON = "The job was not started before the shift ended.";

/** Cloud Tasks refuses a schedule time more than 30 days ahead; a day of margin. A check that runs early re-arms itself. */
export const MAX_TASK_DELAY_MS = 29 * DAY;

/** A task may run this much before the due time and still count as due (clock differences, whole-second schedules). */
export const NO_SHOW_EARLY_TOLERANCE_MS = MINUTE;

export interface BookingForNoShow {
	status?: string | null;
	providerId?: unknown;
	userApprovalRequested?: boolean | null;
	startDate?: Date | string | null;
	hours?: number | null;
	cancellationReason?: string | null;
}

/** When the booking is cancelled if nobody started it: its scheduled end plus the grace period. Null when it has no valid shift. */
export const noShowDueAt = (
	booking: Pick<BookingForNoShow, "startDate" | "hours">,
	graceMinutes: number,
): Date | null => {
	const start = booking.startDate ? new Date(booking.startDate).getTime() : NaN;
	const hours = Number(booking.hours);
	const due = start + hours * HOUR + graceMinutes * MINUTE;
	return Number.isFinite(due) && hours > 0 && graceMinutes >= 0 ? new Date(due) : null;
};

/** When the check should run: at the due time, or as late as Cloud Tasks allows when that is further away. */
export const noShowCheckAt = (dueAt: Date, now: Date) =>
	new Date(Math.min(dueAt.getTime(), now.getTime() + MAX_TASK_DELAY_MS));

export type NoShowDecision =
	/** Accepted, no start request, shift and grace over: cancel and refund. */
	| "cancel"
	/** Still accepted and waiting, but the due time has not come (the shift is far ahead, or the grace was raised). */
	| "not_due"
	/** Already cancelled by this rule: only make sure the refund was requested (a run that failed at the refund retries). */
	| "refund_only"
	/** Started, completed, cancelled another way, released, or the provider asked to start: nothing to do. */
	| "not_applicable";

/**
 * What the check does with a booking now. A booking whose provider asked to start is never cancelled here: the
 * provider says they turned up, so a person decides (it is on the console's attention list as a start request waiting).
 */
export const decideNoShow = (booking: BookingForNoShow, now: Date, graceMinutes: number): NoShowDecision => {
	if (booking.status === "cancelled") {
		return booking.cancellationReason === NO_SHOW_CANCELLATION_REASON && booking.providerId
			? "refund_only"
			: "not_applicable";
	}
	if (booking.status !== "pending" || !booking.providerId || booking.userApprovalRequested) return "not_applicable";
	const dueAt = noShowDueAt(booking, graceMinutes);
	if (!dueAt) return "not_applicable";
	return now.getTime() >= dueAt.getTime() - NO_SHOW_EARLY_TOLERANCE_MS ? "cancel" : "not_due";
};

/** The Mongo filter for the one transition the rule makes (a start request or any other change in between loses the race). */
export const noShowTransitionFilter = (bookingId: unknown, providerId: unknown) => ({
	_id: bookingId,
	status: "pending",
	providerId,
	userApprovalRequested: { $ne: true },
});
