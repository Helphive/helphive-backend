const DAY_MS = 24 * 60 * 60 * 1000;
// How far startDate may sit from a whole number of days after now and still count as an Android picker value.
const PICKER_DRIFT_MS = 3 * 60 * 60 * 1000;

export interface BookingStartInput {
	startAt?: string;
	startDate: string;
	startTime: string;
}

/** The previous server logic, unchanged: the date part of startDate (or of startTime when later) plus startTime's time, as UTC. */
export const legacyCombineBookingStart = (startDate: string, startTime: string): Date => {
	let dateParts = startDate.split("T")[0].split("-");
	if (startDate < startTime) {
		dateParts = startTime.split("T")[0].split("-");
	}
	const timeParts = startTime.split("T")[1].split(".")[0];
	const combinedDateString = `${dateParts[0]}-${dateParts[1]}-${dateParts[2]}T${timeParts}`;
	return new Date(combinedDateString + "Z");
};

const toTime = (value: unknown) => (typeof value === "string" ? new Date(value).getTime() : NaN);

/**
 * Start instant of a booking, or null when the input is not a date.
 *
 * With `startAt` the client sent the exact instant and it is used as is. Without it (the shipped Android app),
 * startDate is the chosen day at the clock time the date picker opened, moments before the request, and startTime is
 * the chosen time of day on the day it was picked. So startDate sits close to a whole number of days after now, and
 * that number is how far ahead the chosen day is. A payload that does not fit that shape gets the previous behaviour.
 *
 * Across a daylight-saving change before the chosen day the result keeps today's UTC offset, so it is an hour off
 * (as before); the day is right.
 */
export const resolveBookingStart = (
	{ startAt, startDate, startTime }: BookingStartInput,
	now: Date = new Date(),
): Date | null => {
	if (startAt !== undefined) {
		const at = toTime(startAt);
		return Number.isNaN(at) ? null : new Date(at);
	}

	const date = toTime(startDate);
	const time = toTime(startTime);
	if (Number.isNaN(date) || Number.isNaN(time)) return null;

	const fromNow = date - now.getTime();
	const daysAhead = Math.round(fromNow / DAY_MS);
	if (Math.abs(fromNow - daysAhead * DAY_MS) <= PICKER_DRIFT_MS) {
		return new Date(time + daysAhead * DAY_MS);
	}

	try {
		const legacy = legacyCombineBookingStart(startDate, startTime);
		return Number.isNaN(legacy.getTime()) ? null : legacy;
	} catch {
		// A date with no time part ("2026-11-21"); the previous code threw here and answered 500.
		return null;
	}
};
