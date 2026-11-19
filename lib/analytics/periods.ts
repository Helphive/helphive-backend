// Calendar arithmetic for analytics (pure): operator-day ranges in a time zone, day/week/month buckets, the previous
// period, and filling empty buckets. Weeks start on Monday; months on the 1st. Days are the operator's calendar days
// in `tz`, so a bucket starts at local midnight even across daylight-saving changes.
import { wallClock, zonedMidnight } from "../operations";

export const INTERVALS = ["day", "week", "month"] as const;
export type Interval = (typeof INTERVALS)[number];

/** At most this many buckets in one series, and this many calendar days in one range. */
export const MAX_BUCKETS = 400;
export const MAX_RANGE_DAYS = 5 * 366;
/** No range starts before this day (the platform did not exist). */
export const EARLIEST_DAY = "2020-01-01";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Day {
	year: number;
	month: number;
	day: number;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-19" as a calendar day, or null when it is not a real date. */
export const parseDay = (value: string): Day | null => {
	const m = DAY_PATTERN.exec(value);
	if (!m) return null;
	const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const d = new Date(Date.UTC(year, month - 1, day));
	if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
	return { year, month, day };
};

const pad = (n: number) => String(n).padStart(2, "0");
export const formatDay = (d: Day) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;
export const formatMonth = (d: Day) => `${d.year}-${pad(d.month)}`;

const utc = (d: Day) => Date.UTC(d.year, d.month - 1, d.day);
const fromUtc = (ms: number): Day => {
	const x = new Date(ms);
	return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() };
};

export const addDays = (d: Day, n: number): Day => fromUtc(utc(d) + n * DAY_MS);
export const addMonths = (d: Day, n: number): Day => fromUtc(Date.UTC(d.year, d.month - 1 + n, 1));
/** Calendar days from a to b (b - a). */
export const daysBetween = (a: Day, b: Day) => Math.round((utc(b) - utc(a)) / DAY_MS);
export const compareDays = (a: Day, b: Day) => utc(a) - utc(b);

/** The calendar day an instant falls on in `tz`. */
export const dayIn = (instant: number, tz: string): Day => {
	const w = wallClock(instant, tz);
	return { year: w.year, month: w.month, day: w.day };
};

/** Local midnight starting `d` in `tz`, as an instant. */
export const startOfDay = (d: Day, tz: string) => zonedMidnight(d.year, d.month, d.day, tz);

/** The first day of the bucket holding `d`: itself, its Monday, or the 1st of its month. */
export const bucketStartDay = (d: Day, interval: Interval): Day => {
	if (interval === "day") return d;
	if (interval === "month") return { year: d.year, month: d.month, day: 1 };
	const weekday = (new Date(utc(d)).getUTCDay() + 6) % 7; // 0 = Monday
	return addDays(d, -weekday);
};

export const nextBucketDay = (d: Day, interval: Interval): Day =>
	interval === "day" ? addDays(d, 1) : interval === "week" ? addDays(d, 7) : addMonths(d, 1);

export interface Bucket {
	/** First calendar day of the bucket ("2026-11-16"), which may be before the range starts. */
	key: string;
	/** Local midnight of that day, as an instant. */
	start: number;
}

export interface ResolvedRange {
	tz: string;
	interval: Interval;
	fromDay: Day;
	/** Inclusive. */
	toDay: Day;
	/** Local midnight of fromDay. */
	start: Date;
	/** Local midnight after toDay (exclusive). */
	end: Date;
	days: number;
	buckets: Bucket[];
}

export class PeriodError extends Error {
	constructor(
		message: string,
		readonly field: string,
	) {
		super(message);
	}
}

/**
 * The range from local midnight of `fromDay` to the end of `toDay` in `tz`, cut into buckets. Refuses reversed
 * ranges, ranges over MAX_RANGE_DAYS and series over MAX_BUCKETS (the caller suggests a coarser interval).
 */
export const resolveRange = (fromDay: Day, toDay: Day, tz: string, interval: Interval): ResolvedRange => {
	const days = daysBetween(fromDay, toDay) + 1;
	if (days < 1) throw new PeriodError("from must be on or before to.", "from");
	if (days > MAX_RANGE_DAYS) throw new PeriodError(`A range can cover at most ${MAX_RANGE_DAYS} days.`, "from");
	const buckets: Bucket[] = [];
	for (let d = bucketStartDay(fromDay, interval); compareDays(d, toDay) <= 0; d = nextBucketDay(d, interval)) {
		if (buckets.length >= MAX_BUCKETS) {
			throw new PeriodError(
				`That range has more than ${MAX_BUCKETS} ${interval}s; choose a longer interval.`,
				"interval",
			);
		}
		buckets.push({ key: formatDay(d), start: startOfDay(d, tz) });
	}
	return {
		tz,
		interval,
		fromDay,
		toDay,
		start: new Date(startOfDay(fromDay, tz)),
		end: new Date(startOfDay(addDays(toDay, 1), tz)),
		days,
		buckets,
	};
};

/** The same number of days immediately before the range, with the same interval and zone. */
export const previousRange = (r: ResolvedRange): ResolvedRange => {
	const toDay = addDays(r.fromDay, -1);
	return resolveRange(addDays(toDay, -(r.days - 1)), toDay, r.tz, r.interval);
};

/** Index of the bucket holding an instant, or -1 outside the range. */
export const bucketIndex = (r: ResolvedRange, instant: number) => {
	if (instant < r.start.getTime() || instant >= r.end.getTime()) {
		// A bucket start returned by the database may precede the range (a week starting before `from`).
		if (!(r.buckets.length && instant >= r.buckets[0].start && instant < r.start.getTime())) return -1;
	}
	let lo = 0;
	let hi = r.buckets.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (r.buckets[mid].start <= instant) lo = mid;
		else hi = mid - 1;
	}
	return r.buckets[lo].start <= instant ? lo : -1;
};

/** One value per bucket from sparse rows ({ t, value }); buckets without a row get `empty` (0, or null for rates). */
export const fillBuckets = <T>(
	r: ResolvedRange,
	rows: { t: Date | number; value: T }[],
	empty: T,
	merge?: (a: T, b: T) => T,
): T[] => {
	const out: T[] = r.buckets.map(() => empty);
	for (const row of rows) {
		const i = bucketIndex(r, new Date(row.t).getTime());
		if (i < 0) continue;
		out[i] = merge && out[i] !== empty ? merge(out[i], row.value) : row.value;
	}
	return out;
};

/** The default range: the last `days` days ending today in `tz`. */
export const defaultDays = (now: Date, tz: string, days = 30) => {
	const toDay = dayIn(now.getTime(), tz);
	return { fromDay: addDays(toDay, -(days - 1)), toDay };
};

/** Months (as "YYYY-MM") from the month of `from` to the month of `to`, inclusive. */
export const monthsBetween = (from: Day, to: Day): string[] => {
	const out: string[] = [];
	for (let d = { ...from, day: 1 }; compareDays(d, to) <= 0; d = addMonths(d, 1)) out.push(formatMonth(d));
	return out;
};

export const dayMs = DAY_MS;
