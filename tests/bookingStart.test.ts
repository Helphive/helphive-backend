// Run with: npx ts-node tests/bookingStart.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	legacyCombineBookingStart,
	resolveBookingStart,
} from "../controllers/user-controllers/utils/bookingStart.utils";

const MIN = 60 * 1000;

/** The instant of a local wall-clock time at a fixed UTC offset (minutes east of UTC). */
const local = (y: number, mo: number, d: number, h: number, mi: number, offset: number) =>
	new Date(Date.UTC(y, mo - 1, d, h, mi) - offset * MIN);

/** Local calendar fields of an instant at a fixed offset. */
const fields = (instant: Date, offset: number) => {
	const t = new Date(instant.getTime() + offset * MIN);
	return {
		y: t.getUTCFullYear(),
		mo: t.getUTCMonth() + 1,
		d: t.getUTCDate(),
		h: t.getUTCHours(),
		mi: t.getUTCMinutes(),
	};
};

type Day = { y: number; mo: number; d: number };
type Pick = { day: Day; h: number; mi: number };

const addDays = (day: Day, n: number): Day => {
	const t = new Date(Date.UTC(day.y, day.mo - 1, day.d + n));
	return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** A local-midnight payload (the web app before startAt): startDate is local midnight, startTime is today. */
const midnightPayload = (pick: Pick, now: Date, offset: number) => {
	const today = fields(now, offset);
	return {
		startDate: local(pick.day.y, pick.day.mo, pick.day.d, 0, 0, offset).toISOString(),
		startTime: local(today.y, today.mo, today.d, pick.h, pick.mi, offset).toISOString(),
	};
};

/**
 * Android (step2.tsx): startDate is the day at the hour and minute the date picker opened (seconds zeroed), startTime
 * is the time on the day the time picker opened.
 */
const androidPayload = (pick: Pick, now: Date, offset: number, openedMinutesAgo = 2, offsetOnDay = offset) => {
	const opened = fields(new Date(now.getTime() - openedMinutesAgo * MIN), offset);
	return {
		startDate: local(pick.day.y, pick.day.mo, pick.day.d, opened.h, opened.mi, offsetOnDay).toISOString(),
		startTime: local(opened.y, opened.mo, opened.d, pick.h, pick.mi, offset).toISOString(),
	};
};

/** An independent copy of the handler code before this change, to check the fallback against. */
const previousHandlerLogic = (startDate: string, startTime: string) => {
	let dateParts = startDate.split("T")[0].split("-");
	if (startDate < startTime) dateParts = startTime.split("T")[0].split("-");
	const timeParts = startTime.split("T")[1].split(".")[0];
	return new Date(`${dateParts[0]}-${dateParts[1]}-${dateParts[2]}T${timeParts}Z`);
};

const ZONES = [
	{ name: "UTC-8", offset: -8 * 60 },
	{ name: "UTC", offset: 0 },
	{ name: "UTC+5", offset: 5 * 60 },
	{ name: "UTC+5:30", offset: 5 * 60 + 30 },
	{ name: "UTC+13", offset: 13 * 60 },
];

// Submission times spread over the customer's day, and chosen times before and after the current clock time.
const NOWS = [
	"2026-11-20T00:20:00Z",
	"2026-11-20T06:45:00Z",
	"2026-11-20T11:00:00Z",
	"2026-11-20T17:30:00Z",
	"2026-11-20T23:50:00Z",
];
const TIMES = [
	{ h: 0, mi: 30 },
	{ h: 8, mi: 0 },
	{ h: 14, mi: 15 },
	{ h: 21, mi: 0 },
	{ h: 23, mi: 45 },
];

test("startAt is used as is", () => {
	const now = new Date("2026-11-20T10:00:00Z");
	const result = resolveBookingStart(
		{ startAt: "2026-11-21T03:00:00.000Z", startDate: "2020-01-01T00:00:00Z", startTime: "2020-01-01T00:00:00Z" },
		now,
	);
	assert.equal(result?.toISOString(), "2026-11-21T03:00:00.000Z");
	assert.equal(
		resolveBookingStart(
			{ startAt: "2026-11-21T08:00:00+05:00", startDate: "x", startTime: "y" },
			now,
		)?.toISOString(),
		"2026-11-21T03:00:00.000Z",
	);
});

test("an invalid startAt returns null", () => {
	const now = new Date("2026-11-20T10:00:00Z");
	const valid = { startDate: "2026-11-21T09:58:00.000Z", startTime: "2026-11-20T08:00:00.000Z" };
	assert.equal(resolveBookingStart({ startAt: "not a date", ...valid }, now), null);
	assert.equal(resolveBookingStart({ startAt: "", ...valid }, now), null);
});

for (const { name, offset } of ZONES) {
	test(`${name}: every Android choice lands on the chosen local day and time`, () => {
		for (const iso of NOWS) {
			const now = new Date(iso);
			const today = fields(now, offset);
			for (const ahead of [0, 1, 2, 7, 30]) {
				for (const time of TIMES) {
					const pick = { day: addDays(today, ahead), ...time };
					const expected = local(pick.day.y, pick.day.mo, pick.day.d, pick.h, pick.mi, offset).toISOString();
					const result = resolveBookingStart(androidPayload(pick, now, offset), now);
					assert.equal(result?.toISOString(), expected, `${iso} +${ahead}d ${JSON.stringify(time)}`);
				}
			}
		}
	});
}

test("Android same-day booking", () => {
	const offset = 5 * 60;
	const now = new Date("2026-11-20T04:00:00Z"); // 09:00 local
	const pick = { day: { y: 2026, mo: 11, d: 20 }, h: 15, mi: 30 };
	assert.equal(
		resolveBookingStart(androidPayload(pick, now, offset), now)?.toISOString(),
		local(2026, 11, 20, 15, 30, offset).toISOString(),
	);
});

test("Android form left open 2 hours still uses the picker method", () => {
	const offset = 5 * 60;
	const now = new Date("2026-11-20T09:40:00Z"); // 14:40 local, date picker opened at 12:40
	const pick = { day: { y: 2026, mo: 11, d: 21 }, h: 3, mi: 0 };
	const payload = androidPayload(pick, now, offset, 120);
	const expected = local(2026, 11, 21, 3, 0, offset).toISOString();
	assert.equal(resolveBookingStart(payload, now)?.toISOString(), expected);
	// The previous logic puts this one a day late.
	assert.notEqual(previousHandlerLogic(payload.startDate, payload.startTime).toISOString(), expected);
});

test("Android form left open 5 hours falls back to the previous logic", () => {
	const offset = 5 * 60;
	const now = new Date("2026-11-20T09:40:00Z");
	const pick = { day: { y: 2026, mo: 11, d: 21 }, h: 3, mi: 0 };
	const payload = androidPayload(pick, now, offset, 300);
	assert.equal(
		resolveBookingStart(payload, now)?.toISOString(),
		previousHandlerLogic(payload.startDate, payload.startTime).toISOString(),
	);
});

test("local-midnight payload with drift over 3 hours falls back to the previous logic", () => {
	const offset = 5 * 60;
	const now = new Date("2026-11-20T06:00:00Z"); // 11:00 local: startDate is 11 hours from a whole day
	const pick = { day: { y: 2026, mo: 11, d: 21 }, h: 8, mi: 0 };
	const payload = midnightPayload(pick, now, offset);
	assert.equal(payload.startDate, "2026-11-20T19:00:00.000Z");
	assert.equal(payload.startTime, "2026-11-20T03:00:00.000Z");
	const result = resolveBookingStart(payload, now);
	assert.equal(result?.toISOString(), previousHandlerLogic(payload.startDate, payload.startTime).toISOString());
	assert.equal(result?.toISOString(), "2026-11-20T03:00:00.000Z"); // the reported bug, unchanged without startAt
});

test("the fallback reproduces the previous handler logic", () => {
	const cases = [
		["2026-11-20T19:00:00.000Z", "2026-11-20T03:00:00.000Z"],
		["2026-11-20T00:00:00.000Z", "2026-11-20T15:45:00.000Z"],
		["2026-11-25T08:00:00.000Z", "2026-11-19T22:10:30.500Z"],
		["2026-12-31T23:00:00.000Z", "2027-01-01T01:00:00.000Z"],
	];
	for (const [startDate, startTime] of cases) {
		assert.equal(
			legacyCombineBookingStart(startDate, startTime).toISOString(),
			previousHandlerLogic(startDate, startTime).toISOString(),
		);
	}
});

test("daylight-saving change before the chosen day keeps the day and shifts the hour, as before", () => {
	// Los Angeles: UTC-7 on Fri 30 Oct 2026, UTC-8 from Sun 1 Nov. Customer books Mon 2 Nov 08:00 on Android.
	const before = -7 * 60;
	const after = -8 * 60;
	const now = new Date("2026-10-30T20:00:00Z"); // 13:00 local
	const pick = { day: { y: 2026, mo: 11, d: 2 }, h: 8, mi: 0 };
	const result = resolveBookingStart(androidPayload(pick, now, before, 2, after), now);
	assert.ok(result);
	assert.deepEqual(fields(result, after), { y: 2026, mo: 11, d: 2, h: 7, mi: 0 });
});

test("non-date input returns null", () => {
	const now = new Date("2026-11-20T10:00:00Z");
	assert.equal(resolveBookingStart({ startDate: "not a date", startTime: "2026-11-20T08:00:00Z" }, now), null);
	assert.equal(resolveBookingStart({ startDate: "2026-11-21T09:58:00Z", startTime: "" }, now), null);
	// A date with no time part used to throw in the previous logic (HTTP 500); now it is rejected.
	assert.equal(resolveBookingStart({ startDate: "2026-11-25T03:00:00Z", startTime: "2026-11-25" }, now), null);
});
