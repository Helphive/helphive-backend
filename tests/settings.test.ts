// Platform settings: the defaults reproduce the previous hard-coded behaviour exactly, validation, the cache with an
// injected clock, and the announcement window. Pure; the store is replaced, so no database.
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_SETTINGS,
	SETTING_DEFINITIONS,
	SETTING_KEYS,
	SETTINGS_TTL_MS,
	activeAnnouncement,
	bookingExpiryAt,
	checkBookingRange,
	checkLeadTime,
	checkServiceOffered,
	earningReleaseAt,
	getSettings,
	invalidateSettings,
	leadTimeMessage,
	mergeStoredSettings,
	providerShareFor,
	setSettingsDependencies,
	stripeModeOf,
	testModeNotice,
	validateSettingValue,
} from "../lib/settings";
import { PROVIDER_SHARE } from "../lib/operations";
import { setLogSink } from "../lib/logger";

setLogSink(() => undefined);

test("defaults are today's values", () => {
	assert.equal(DEFAULT_SETTINGS["payments.platformFeePercent"], 5);
	assert.equal(DEFAULT_SETTINGS["payments.earningsReleaseDelaySeconds"], 30);
	assert.equal(DEFAULT_SETTINGS["bookings.minHourlyRate"], 20);
	assert.equal(DEFAULT_SETTINGS["bookings.maxHourlyRate"], 2000);
	assert.equal(DEFAULT_SETTINGS["bookings.minHours"], 1);
	assert.equal(DEFAULT_SETTINGS["bookings.maxHours"], 1000);
	assert.equal(DEFAULT_SETTINGS["bookings.minLeadTimeMinutes"], 60);
	assert.equal(DEFAULT_SETTINGS["bookings.expiryMinutesBeforeStart"], 0);
	assert.deepEqual(
		DEFAULT_SETTINGS["services.catalogue"].map((s) => [s.id, s.name, s.active]),
		[
			[1, "Public Area Attendant", true],
			[2, "Room Attendant", true],
			[3, "Linen Porter", true],
		],
	);
	assert.equal(DEFAULT_SETTINGS["announcements.banner"], null);
	for (const key of SETTING_KEYS) {
		assert.equal(validateSettingValue(key, DEFAULT_SETTINGS[key]).ok, true, `${key}'s default is valid`);
		assert.ok(SETTING_DEFINITIONS[key].affects.length > 20, `${key} says what it affects`);
	}
});

test("default fee: the provider's share is exactly the previous 0.95, so earnings are byte-for-byte the same", () => {
	assert.equal(providerShareFor(5), PROVIDER_SHARE);
	for (const paid of [20, 33.33, 80, 123.45, 1999, 2_000_000]) assert.equal(paid * providerShareFor(5), paid * 0.95);
	assert.equal(providerShareFor(10), 0.9);
});

test("default release delay: 30 seconds after completion", () => {
	assert.equal(earningReleaseAt(1_000_000, 30).getTime(), 1_000_000 + 30 * 1000);
});

test("default lead time: the same check and message as the hard-coded one hour", () => {
	const now = new Date("2026-11-19T12:00:00Z");
	assert.equal(leadTimeMessage(60), "Start date and time must be at least 1 hour in the future.");
	assert.equal(checkLeadTime(new Date("2026-11-19T12:59:59.999Z"), now, 60), leadTimeMessage(60));
	assert.equal(
		checkLeadTime(new Date("2026-11-19T13:00:00Z"), now, 60),
		null,
		"exactly one hour is allowed, as before",
	);
	assert.equal(leadTimeMessage(120), "Start date and time must be at least 2 hours in the future.");
	assert.equal(leadTimeMessage(90), "Start date and time must be at least 90 minutes in the future.");
	assert.equal(checkLeadTime(now, now, 0), null);
});

test("default expiry: the task runs at the start time", () => {
	const start = new Date("2026-11-20T08:00:00Z");
	assert.equal(bookingExpiryAt(start, 0).getTime(), start.getTime());
	assert.equal(bookingExpiryAt(start, 30).toISOString(), "2026-11-20T07:30:00.000Z");
});

test("default rate and hours bounds: same accept/refuse and message as isInt({ min, max })", () => {
	const s = DEFAULT_SETTINGS;
	const cases: [unknown, string | null][] = [
		[20, null],
		["20", null],
		[2000, null],
		["0020", null],
		["+20", null],
		[19, "Rate must be between 20 and 2000"],
		[2001, "Rate must be between 20 and 2000"],
		["20.5", "Rate must be between 20 and 2000"],
		[20.5, "Rate must be between 20 and 2000"],
		["", "Rate must be between 20 and 2000"],
		["abc", "Rate must be between 20 and 2000"],
		[" 20", "Rate must be between 20 and 2000"],
	];
	for (const [value, expected] of cases)
		assert.equal(checkBookingRange("rate", value, s), expected, `rate ${JSON.stringify(value)}`);
	assert.equal(checkBookingRange("hours", 1, s), null);
	assert.equal(checkBookingRange("hours", 1000, s), null);
	assert.equal(checkBookingRange("hours", 0, s), "Hours must be between 1 and 1000");
	assert.equal(checkBookingRange("hours", 1001, s), "Hours must be between 1 and 1000");
});

test("default services: every service can be booked", () => {
	for (const id of [1, 2, 3, "2"])
		assert.equal(checkServiceOffered(id, DEFAULT_SETTINGS["services.catalogue"]), null);
	const paused = DEFAULT_SETTINGS["services.catalogue"].map((s) => (s.id === 3 ? { ...s, active: false } : s));
	assert.equal(checkServiceOffered(3, paused), "Linen Porter is not offered at the moment.");
});

test("validation: numbers, ranges, decimals and min/max pairs", () => {
	assert.equal(validateSettingValue("payments.platformFeePercent", 7.5).ok, true);
	assert.equal(validateSettingValue("payments.platformFeePercent", 7.555).ok, false);
	assert.equal(validateSettingValue("payments.platformFeePercent", -1).ok, false);
	assert.equal(validateSettingValue("payments.platformFeePercent", 51).ok, false);
	assert.equal(validateSettingValue("payments.platformFeePercent", "5" as any).ok, false);
	assert.equal(validateSettingValue("payments.earningsReleaseDelaySeconds", 1.5).ok, false);
	assert.equal(validateSettingValue("payments.earningsReleaseDelaySeconds", 3 * 86400).ok, true);
	const minAboveMax = validateSettingValue("bookings.minHourlyRate", 2500);
	assert.equal(minAboveMax.ok, false);
	assert.match(!minAboveMax.ok ? minAboveMax.message : "", /cannot be above the maximum/);
	assert.equal(validateSettingValue("bookings.maxHours", 0).ok, false);
	assert.equal(
		validateSettingValue("bookings.maxHourlyRate", 15, { ...DEFAULT_SETTINGS, "bookings.minHourlyRate": 10 }).ok,
		true,
	);
});

test("validation: services keep their fixed ids, need names and at least one active", () => {
	const base = DEFAULT_SETTINGS["services.catalogue"];
	assert.equal(
		validateSettingValue(
			"services.catalogue",
			base.map((s) => ({ ...s, description: "x" })),
		).ok,
		true,
	);
	assert.equal(validateSettingValue("services.catalogue", base.slice(0, 2)).ok, false);
	assert.equal(
		validateSettingValue(
			"services.catalogue",
			base.map((s) => ({ ...s, id: s.id + 1 })),
		).ok,
		false,
	);
	assert.equal(
		validateSettingValue(
			"services.catalogue",
			base.map((s) => ({ ...s, active: false })),
		).ok,
		false,
	);
	assert.equal(
		validateSettingValue(
			"services.catalogue",
			base.map((s) => ({ ...s, name: " " })),
		).ok,
		false,
	);
	assert.equal(
		validateSettingValue(
			"services.catalogue",
			base.map((s) => ({ ...s, price: 1 })),
		).ok,
		false,
	);
	const trimmed = validateSettingValue("services.catalogue", [base[2], base[0], { ...base[1], name: "  Rooms  " }]);
	assert.ok(trimmed.ok);
	assert.deepEqual(trimmed.ok && trimmed.value.map((s) => s.name), [
		"Public Area Attendant",
		"Rooms",
		"Linen Porter",
	]);
});

test("validation: the announcement banner", () => {
	assert.equal(validateSettingValue("announcements.banner", null).ok, true);
	const ok = validateSettingValue("announcements.banner", {
		text: " Hi ",
		audience: "providers",
		startsAt: "2026-11-20T00:00:00Z",
		endsAt: "2026-11-21",
	});
	assert.ok(ok.ok);
	assert.deepEqual(ok.ok && ok.value, {
		text: "Hi",
		audience: "providers",
		tone: "info",
		startsAt: "2026-11-20T00:00:00.000Z",
		endsAt: "2026-11-21T00:00:00.000Z",
	});
	assert.equal(validateSettingValue("announcements.banner", { text: "" }).ok, false);
	assert.equal(validateSettingValue("announcements.banner", { text: "x".repeat(281) }).ok, false);
	assert.equal(validateSettingValue("announcements.banner", { text: "x", audience: "admins" }).ok, false);
	assert.equal(
		validateSettingValue("announcements.banner", { text: "x", startsAt: "2026-11-21", endsAt: "2026-11-20" }).ok,
		false,
	);
	assert.equal(validateSettingValue("announcements.banner", { text: "x", link: "https://evil" }).ok, false);
});

test("the banner shows only to its audience and inside its window", () => {
	const banner = {
		text: "Maintenance",
		audience: "providers" as const,
		tone: "info" as const,
		startsAt: "2026-11-20T00:00:00.000Z",
		endsAt: "2026-11-21T00:00:00.000Z",
	};
	const during = new Date("2026-11-20T12:00:00Z");
	assert.equal(activeAnnouncement(banner, "providers", during), banner);
	assert.equal(activeAnnouncement(banner, "all", during), banner);
	assert.equal(activeAnnouncement(banner, "customers", during), null);
	assert.equal(activeAnnouncement(banner, "providers", new Date("2026-11-19T23:59:59Z")), null);
	assert.equal(activeAnnouncement(banner, "providers", new Date("2026-11-21T00:00:00Z")), null);
	assert.equal(
		activeAnnouncement({ ...banner, audience: "all", startsAt: null, endsAt: null }, "customers", during)?.text,
		"Maintenance",
	);
	assert.equal(activeAnnouncement(null, "customers", during), null);
});

test("stored values merge over the defaults; an invalid stored value falls back to its default", () => {
	const merged = mergeStoredSettings({ "payments.platformFeePercent": 7, "bookings.minHours": "lots", unknown: 1 });
	assert.equal(merged["payments.platformFeePercent"], 7);
	assert.equal(merged["bookings.minHours"], 1);
	assert.deepEqual(mergeStoredSettings({}), DEFAULT_SETTINGS);
});

test("Stripe mode and the test-mode notice", () => {
	assert.equal(stripeModeOf("sk_test_abc"), "test");
	assert.equal(stripeModeOf("rk_live_abc"), "live");
	assert.equal(stripeModeOf(undefined), "unknown");
	assert.equal(testModeNotice(30), "Test mode: provider earnings are released 30 seconds after completion");
});

test("the cache: one read per lifetime, invalidation, and the last good values when the store fails", async () => {
	let clock = 0;
	let reads = 0;
	let stored: Record<string, unknown> = { "payments.platformFeePercent": 6 };
	let fail = false;
	setSettingsDependencies({
		now: () => clock,
		loader: async () => {
			reads++;
			if (fail) throw new Error("down");
			return stored;
		},
	});
	const [a, b] = await Promise.all([getSettings(), getSettings()]);
	assert.equal(reads, 1, "parallel callers share one read");
	assert.equal(a["payments.platformFeePercent"], 6);
	assert.equal(b, a);
	clock += SETTINGS_TTL_MS - 1;
	await getSettings();
	assert.equal(reads, 1);
	clock += 1;
	stored = { "payments.platformFeePercent": 8 };
	assert.equal((await getSettings())["payments.platformFeePercent"], 8);
	assert.equal(reads, 2);
	fail = true;
	invalidateSettings();
	assert.equal(
		(await getSettings())["payments.platformFeePercent"],
		DEFAULT_SETTINGS["payments.platformFeePercent"],
		"nothing cached: defaults",
	);
	fail = false;
	clock += 6000;
	assert.equal((await getSettings())["payments.platformFeePercent"], 8, "retried after a short pause");
	fail = true;
	clock += SETTINGS_TTL_MS;
	assert.equal((await getSettings())["payments.platformFeePercent"], 8, "store down: last good values");
});
