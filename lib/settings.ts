// Platform settings: typed, validated values that replace hard-coded ones. Each falls back to today's value, so nothing
// changes until an admin edits it (PATCH /admin/settings/:key, audited). Values are read through an in-memory cache
// with a short lifetime; a failed read keeps the last good values (or the defaults), so a database hiccup never
// changes behaviour. tests/settings.test.ts proves the defaults reproduce the previous hard-coded behaviour.
import log from "./logger";

export const SETTING_GROUPS = {
	payments: "Payments and fees",
	bookings: "Bookings",
	services: "Services",
	announcements: "Announcements",
} as const;
export type SettingGroup = keyof typeof SETTING_GROUPS;

export interface ServiceSetting {
	id: number;
	name: string;
	description: string;
	active: boolean;
}

export const ANNOUNCEMENT_AUDIENCES = ["all", "customers", "providers"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export interface AnnouncementSetting {
	text: string;
	audience: AnnouncementAudience;
	tone: "info" | "warning";
	startsAt: string | null;
	endsAt: string | null;
}

export interface SettingsSnapshot {
	"payments.platformFeePercent": number;
	"payments.earningsReleaseDelaySeconds": number;
	"bookings.minHourlyRate": number;
	"bookings.maxHourlyRate": number;
	"bookings.minHours": number;
	"bookings.maxHours": number;
	"bookings.minLeadTimeMinutes": number;
	"bookings.expiryMinutesBeforeStart": number;
	"bookings.noShowGraceMinutes": number;
	"services.catalogue": ServiceSetting[];
	"announcements.banner": AnnouncementSetting | null;
}
export type SettingKey = keyof SettingsSnapshot;

type Kind = "number" | "integer" | "services" | "announcement";

export interface SettingDefinition<K extends SettingKey = SettingKey> {
	key: K;
	group: SettingGroup;
	label: string;
	/** What the value changes, in plain words for the console. */
	affects: string;
	kind: Kind;
	unit?: string;
	min?: number;
	max?: number;
	/** Most decimals a number may have. */
	decimals?: number;
	default: SettingsSnapshot[K];
}

const DAY_SECONDS = 24 * 60 * 60;

export const DEFAULT_SERVICES: ServiceSetting[] = [
	{
		id: 1,
		name: "Public Area Attendant",
		description: "Keeps lobbies, corridors and public areas clean.",
		active: true,
	},
	{ id: 2, name: "Room Attendant", description: "Cleans and prepares guest rooms.", active: true },
	{ id: 3, name: "Linen Porter", description: "Moves linen between laundry, stores and floors.", active: true },
];

export const SETTING_DEFINITIONS: { [K in SettingKey]: SettingDefinition<K> } = {
	"payments.platformFeePercent": {
		key: "payments.platformFeePercent",
		group: "payments",
		label: "Platform fee",
		affects:
			"The share of each completed booking the platform keeps. The provider's earning is the payment minus this percentage, set when the booking completes; earlier earnings keep the fee they were created with.",
		kind: "number",
		unit: "%",
		min: 0,
		max: 50,
		decimals: 2,
		default: 5,
	},
	"payments.earningsReleaseDelaySeconds": {
		key: "payments.earningsReleaseDelaySeconds",
		group: "payments",
		label: "Earnings release delay",
		affects:
			"How long after a booking completes the provider's earning is transferred to their Stripe account. Applies to bookings completed after the change.",
		kind: "integer",
		unit: "seconds",
		min: 0,
		max: 30 * DAY_SECONDS,
		default: 30,
	},
	"bookings.minHourlyRate": {
		key: "bookings.minHourlyRate",
		group: "bookings",
		label: "Minimum hourly rate",
		affects: "The lowest hourly rate a customer can book at (new bookings only).",
		kind: "integer",
		unit: "dollars",
		min: 1,
		max: 10_000,
		default: 20,
	},
	"bookings.maxHourlyRate": {
		key: "bookings.maxHourlyRate",
		group: "bookings",
		label: "Maximum hourly rate",
		affects: "The highest hourly rate a customer can book at (new bookings only).",
		kind: "integer",
		unit: "dollars",
		min: 1,
		max: 10_000,
		default: 2000,
	},
	"bookings.minHours": {
		key: "bookings.minHours",
		group: "bookings",
		label: "Minimum hours per booking",
		affects: "The fewest hours a booking can be for (new bookings only).",
		kind: "integer",
		unit: "hours",
		min: 1,
		max: 1000,
		default: 1,
	},
	"bookings.maxHours": {
		key: "bookings.maxHours",
		group: "bookings",
		label: "Maximum hours per booking",
		affects: "The most hours a booking can be for (new bookings only).",
		kind: "integer",
		unit: "hours",
		min: 1,
		max: 1000,
		default: 1000,
	},
	"bookings.minLeadTimeMinutes": {
		key: "bookings.minLeadTimeMinutes",
		group: "bookings",
		label: "Lead time before a booking starts",
		affects: "How far ahead of its start a booking must be made.",
		kind: "integer",
		unit: "minutes",
		min: 0,
		max: 7 * 24 * 60,
		default: 60,
	},
	"bookings.expiryMinutesBeforeStart": {
		key: "bookings.expiryMinutesBeforeStart",
		group: "bookings",
		label: "Expiry before start",
		affects:
			"A paid booking nobody has accepted is cancelled and refunded this many minutes before its start (0 = at the start time). Applies to bookings created after the change.",
		kind: "integer",
		unit: "minutes",
		min: 0,
		max: 24 * 60,
		default: 0,
	},
	"bookings.noShowGraceMinutes": {
		key: "bookings.noShowGraceMinutes",
		group: "bookings",
		label: "Grace before a job that never started is cancelled",
		affects:
			"A booking a provider accepted but never asked to start is cancelled and refunded in full this many minutes after its scheduled end (start plus booked hours). A booking with a start request waiting is never cancelled this way. A longer value also covers bookings already accepted; a shorter one applies to bookings accepted after the change.",
		kind: "integer",
		unit: "minutes",
		min: 0,
		max: 7 * 24 * 60,
		default: 60,
	},
	"services.catalogue": {
		key: "services.catalogue",
		group: "services",
		label: "Services offered",
		affects:
			"Which services customers can book (an inactive one is refused at booking) and the names and descriptions the public endpoint serves. Ids are fixed: the apps know them.",
		kind: "services",
		default: DEFAULT_SERVICES,
	},
	"announcements.banner": {
		key: "announcements.banner",
		group: "announcements",
		label: "Announcement banner",
		affects:
			"A banner the web and mobile apps fetch from GET /public/announcement, shown to the chosen audience between the start and end times.",
		kind: "announcement",
		default: null,
	},
};

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

export const isSettingKey = (key: unknown): key is SettingKey =>
	typeof key === "string" && Object.prototype.hasOwnProperty.call(SETTING_DEFINITIONS, key);

export const DEFAULT_SETTINGS: SettingsSnapshot = Object.fromEntries(
	SETTING_KEYS.map((key) => [key, SETTING_DEFINITIONS[key].default]),
) as unknown as SettingsSnapshot;

// ---------------------------------------------------------------------------------------------------------------
// Validation (pure)

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string) => ({ ok: false as const, message });

const validateNumber = (def: SettingDefinition, value: unknown): Validation<number> => {
	if (typeof value !== "number" || !Number.isFinite(value)) return fail(`${def.label} must be a number.`);
	if (def.kind === "integer" && !Number.isInteger(value)) return fail(`${def.label} must be a whole number.`);
	if (def.decimals !== undefined) {
		const scaled = value * 10 ** def.decimals;
		if (Math.abs(scaled - Math.round(scaled)) > 1e-6)
			return fail(`${def.label} can have at most ${def.decimals} decimals.`);
	}
	if (def.min !== undefined && value < def.min) return fail(`${def.label} must be at least ${def.min}.`);
	if (def.max !== undefined && value > def.max) return fail(`${def.label} must be at most ${def.max}.`);
	return { ok: true, value };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const cleanText = (value: unknown) => (typeof value === "string" ? value.trim() : null);

const validateServices = (value: unknown): Validation<ServiceSetting[]> => {
	if (!Array.isArray(value)) return fail("Services must be a list.");
	const ids = DEFAULT_SERVICES.map((s) => s.id);
	if (value.length !== ids.length) return fail(`Give exactly the ${ids.length} services (ids ${ids.join(", ")}).`);
	const out: ServiceSetting[] = [];
	for (const item of value) {
		if (!isPlainObject(item)) return fail("Each service must be an object.");
		const unknown = Object.keys(item).filter((k) => !["id", "name", "description", "active"].includes(k));
		if (unknown.length) return fail(`Unknown service field ${unknown[0]}.`);
		if (!ids.includes(item.id as number)) return fail(`Service ids are fixed: ${ids.join(", ")}.`);
		if (out.some((s) => s.id === item.id)) return fail(`Service ${item.id} is listed twice.`);
		const name = cleanText(item.name);
		if (!name || name.length < 2 || name.length > 60)
			return fail("Each service needs a name of 2 to 60 characters.");
		const description = cleanText(item.description ?? "");
		if (description === null || description.length > 300)
			return fail("A service description is at most 300 characters.");
		if (typeof item.active !== "boolean") return fail("Each service needs active: true or false.");
		out.push({ id: item.id as number, name, description, active: item.active });
	}
	if (!out.some((s) => s.active)) return fail("At least one service must stay active.");
	return { ok: true, value: out.sort((a, b) => a.id - b.id) };
};

const isoOrNull = (value: unknown, label: string): Validation<string | null> => {
	if (value === null || value === undefined || value === "") return { ok: true, value: null };
	if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
		return fail(`${label} must be an ISO date and time.`);
	return { ok: true, value: new Date(value).toISOString() };
};

const validateAnnouncement = (value: unknown): Validation<AnnouncementSetting | null> => {
	if (value === null) return { ok: true, value: null };
	if (!isPlainObject(value)) return fail("The announcement must be an object, or null to remove it.");
	const unknown = Object.keys(value).filter((k) => !["text", "audience", "tone", "startsAt", "endsAt"].includes(k));
	if (unknown.length) return fail(`Unknown announcement field ${unknown[0]}.`);
	const text = cleanText(value.text);
	if (!text || text.length > 280) return fail("The announcement text must be 1 to 280 characters.");
	const audience = (value.audience ?? "all") as AnnouncementAudience;
	if (!ANNOUNCEMENT_AUDIENCES.includes(audience)) return fail("audience must be all, customers or providers.");
	const tone = (value.tone ?? "info") as "info" | "warning";
	if (tone !== "info" && tone !== "warning") return fail("tone must be info or warning.");
	const startsAt = isoOrNull(value.startsAt, "startsAt");
	if (!startsAt.ok) return startsAt;
	const endsAt = isoOrNull(value.endsAt, "endsAt");
	if (!endsAt.ok) return endsAt;
	if (startsAt.value && endsAt.value && Date.parse(endsAt.value) <= Date.parse(startsAt.value))
		return fail("The end must be after the start.");
	return { ok: true, value: { text, audience, tone, startsAt: startsAt.value, endsAt: endsAt.value } };
};

const PAIRS: [SettingKey, SettingKey, string][] = [
	["bookings.minHourlyRate", "bookings.maxHourlyRate", "hourly rate"],
	["bookings.minHours", "bookings.maxHours", "hours per booking"],
];

/** Validates one setting's new value against its definition and, for min/max pairs, the other current values. */
export const validateSettingValue = <K extends SettingKey>(
	key: K,
	value: unknown,
	current: SettingsSnapshot = DEFAULT_SETTINGS,
): Validation<SettingsSnapshot[K]> => {
	const def = SETTING_DEFINITIONS[key] as SettingDefinition;
	let result: Validation<unknown>;
	if (def.kind === "number" || def.kind === "integer") result = validateNumber(def, value);
	else if (def.kind === "services") result = validateServices(value);
	else result = validateAnnouncement(value);
	if (!result.ok) return result;
	const next = { ...current, [key]: result.value } as SettingsSnapshot;
	for (const [minKey, maxKey, what] of PAIRS) {
		if ((key === minKey || key === maxKey) && (next[minKey] as number) > (next[maxKey] as number)) {
			return fail(`The minimum ${what} cannot be above the maximum (${next[minKey]} > ${next[maxKey]}).`);
		}
	}
	return result as Validation<SettingsSnapshot[K]>;
};

/** Stored values over the defaults; a stored value that no longer validates falls back to its default. */
export const mergeStoredSettings = (stored: Record<string, unknown>): SettingsSnapshot => {
	const out = { ...DEFAULT_SETTINGS } as Record<SettingKey, unknown>;
	for (const key of SETTING_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(stored, key)) continue;
		const result = validateSettingValue(key, stored[key], out as unknown as SettingsSnapshot);
		if (result.ok) out[key] = result.value;
		else
			log.warn("setting_invalid", `Stored setting ${key} is not valid; using its default`, {
				reason: result.message,
			});
	}
	return out as unknown as SettingsSnapshot;
};

// ---------------------------------------------------------------------------------------------------------------
// Derived rules (pure), used by the code paths the settings replace

/** The provider's share of a payment: 95 % at the default 5 % fee (exactly 0.95). */
export const providerShareFor = (feePercent: number) => (100 - feePercent) / 100;

/** "1 hour", "2 hours", "90 minutes": the lead-time phrase in the booking error. */
export const leadTimePhrase = (minutes: number) => {
	if (minutes > 0 && minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

export const leadTimeMessage = (minutes: number) =>
	`Start date and time must be at least ${leadTimePhrase(minutes)} in the future.`;

/** Rejection for a booking start that is too soon, or null when it is far enough ahead. */
export const checkLeadTime = (start: Date, now: Date, minutes: number) =>
	start.getTime() < now.getTime() + minutes * 60 * 1000 ? leadTimeMessage(minutes) : null;

export const earningReleaseAt = (now: number, delaySeconds: number) => new Date(now + delaySeconds * 1000);

export const bookingExpiryAt = (start: Date, minutesBeforeStart: number) =>
	new Date(start.getTime() - minutesBeforeStart * 60 * 1000);

/** express-validator's isInt: an optional sign and digits. */
const INTEGER = /^[-+]?[0-9]+$/;

/** Booking range check, in the exact words the validator used before ("Rate must be between 20 and 2000"). */
export const checkBookingRange = (
	field: "rate" | "hours",
	value: unknown,
	settings: Pick<
		SettingsSnapshot,
		"bookings.minHourlyRate" | "bookings.maxHourlyRate" | "bookings.minHours" | "bookings.maxHours"
	>,
) => {
	const [min, max] =
		field === "rate"
			? [settings["bookings.minHourlyRate"], settings["bookings.maxHourlyRate"]]
			: [settings["bookings.minHours"], settings["bookings.maxHours"]];
	const message = `${field === "rate" ? "Rate" : "Hours"} must be between ${min} and ${max}`;
	const text = String(value ?? "");
	if (!INTEGER.test(text)) return message;
	const n = Number(text);
	return n < min || n > max ? message : null;
};

/** null when the service can be booked, else the refusal. */
export const checkServiceOffered = (serviceId: unknown, services: ServiceSetting[]) => {
	const service = services.find((s) => s.id === Number(serviceId));
	return !service || service.active ? null : `${service.name} is not offered at the moment.`;
};

/** The banner to show `audience` at `now`, or null. */
export const activeAnnouncement = (
	banner: AnnouncementSetting | null,
	audience: "customers" | "providers" | "all",
	now: Date,
) => {
	if (!banner) return null;
	if (banner.startsAt && Date.parse(banner.startsAt) > now.getTime()) return null;
	if (banner.endsAt && Date.parse(banner.endsAt) <= now.getTime()) return null;
	if (banner.audience !== "all" && audience !== "all" && banner.audience !== audience) return null;
	return banner;
};

/** "test" for sk_test_/rk_test_ keys, "live" for live ones, "unknown" otherwise. */
export const stripeModeOf = (key: string | undefined): "test" | "live" | "unknown" => {
	if (!key) return "unknown";
	if (/^(sk|rk)_test_/.test(key)) return "test";
	if (/^(sk|rk)_live_/.test(key)) return "live";
	return "unknown";
};

export const testModeNotice = (delaySeconds: number) =>
	`Test mode: provider earnings are released ${delaySeconds} seconds after completion`;

// ---------------------------------------------------------------------------------------------------------------
// Cache

export const SETTINGS_TTL_MS = 30_000;

type Loader = () => Promise<Record<string, unknown>>;

const defaultLoader: Loader = async () => {
	// Loaded lazily so the pure parts of this module never pull in Mongoose models.
	/* eslint-disable-next-line @typescript-eslint/no-require-imports */
	const { default: PlatformSettingModel } = require("../dal/models/platformSetting.model");
	const docs = (await PlatformSettingModel.find({}, "key value").maxTimeMS(3000).lean().exec()) as {
		key: string;
		value: unknown;
	}[];
	return Object.fromEntries(docs.map((doc) => [doc.key, doc.value]));
};

let loader: Loader = defaultLoader;
let now: () => number = Date.now;
let cache: { values: SettingsSnapshot; loadedAt: number } | null = null;
let inFlight: Promise<SettingsSnapshot> | null = null;

/** Tests replace the store and the clock. */
export const setSettingsDependencies = (deps: { loader?: Loader; now?: () => number }) => {
	if (deps.loader) loader = deps.loader;
	if (deps.now) now = deps.now;
	cache = null;
	inFlight = null;
};

/** Drops the cache (after an admin edit on this instance; other instances catch up within the lifetime). */
export const invalidateSettings = () => {
	cache = null;
};

/** Current settings: cached for SETTINGS_TTL_MS; on a failed read, the last good values or the defaults. */
export const getSettings = async (): Promise<SettingsSnapshot> => {
	if (cache && now() - cache.loadedAt < SETTINGS_TTL_MS) return cache.values;
	inFlight ??= (async () => {
		try {
			const values = mergeStoredSettings(await loader());
			cache = { values, loadedAt: now() };
			return values;
		} catch (error) {
			log.error("settings_read_failed", "Could not read platform settings; using the last known values", error);
			const values = cache?.values ?? DEFAULT_SETTINGS;
			// Try again soon rather than on every call.
			cache = { values, loadedAt: now() - SETTINGS_TTL_MS + 5000 };
			return values;
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
};

/** One setting's current value. */
export const getSetting = async <K extends SettingKey>(key: K): Promise<SettingsSnapshot[K]> =>
	(await getSettings())[key];
