import mongoose from "mongoose";

export type BookingDisplayStatus =
	| "scheduled"
	| "accepted"
	| "awaiting_start_approval"
	| "in_progress"
	| "completed"
	| "cancelled"
	| "expired";

// Fields that must never be exposed when a user document is populated into a booking response.
export const SAFE_USER_SELECT = "-password -refreshToken -sessionId -resetPasswordTokens -emailVerificationTokens";

// Set by the booking-expired Cloud Task so expiry can be told apart from a user cancellation.
export const EXPIRED_CANCELLATION_REASON = "Expired: no provider accepted before the start time.";

export const isValidObjectId = (value: unknown): value is string =>
	typeof value === "string" && mongoose.Types.ObjectId.isValid(value) && /^[a-f\d]{24}$/i.test(value);

export const getBookingDisplayStatus = (booking: any): BookingDisplayStatus => {
	switch (booking.status) {
		case "completed":
			return "completed";
		case "cancelled":
			// Legacy expiries carry no reason, but were cancelled unassigned at or after the start time.
			if (
				booking.cancellationReason === EXPIRED_CANCELLATION_REASON ||
				(!booking.cancellationReason &&
					!booking.providerId &&
					booking.cancelledAt &&
					new Date(booking.cancelledAt).getTime() >= new Date(booking.startDate).getTime())
			)
				return "expired";
			return "cancelled";
		case "in progress":
			return "in_progress";
		default:
			if (booking.userApprovalRequested) return "awaiting_start_approval";
			if (booking.providerId) return "accepted";
			if (new Date(booking.startDate).getTime() < Date.now()) return "expired";
			return "scheduled";
	}
};

// Plain-object copy of a booking (document or lean) with the derived displayStatus added.
export const withDisplayStatus = (booking: any) => {
	const plain = typeof booking.toObject === "function" ? booking.toObject() : booking;
	return { ...plain, displayStatus: getBookingDisplayStatus(plain) };
};

// e.g. "Room Attendant on Mar 5, 2026" (startDate is stored as UTC wall-clock time)
export const describeBooking = (booking: any): string => {
	const service = booking?.service?.name || "service";
	if (!booking?.startDate) return service;
	const date = new Date(booking.startDate).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
	return `${service} on ${date}`;
};

export const formatMoney = (amount: number): string => `$${Number(amount).toFixed(2)}`;
