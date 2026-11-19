// Durations from environment variables ("15m", "8h", "7d", "90s" or a plain number of seconds).

const UNIT_MS: Record<string, number> = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

/** Milliseconds for "90s", "15m", "8h", "7d" or "3600" (seconds); null for anything else or a non-positive value. */
export const parseDuration = (value: unknown): number | null => {
	if (typeof value !== "string") return null;
	const match = /^\s*(\d{1,7})\s*([smhd]?)\s*$/i.exec(value);
	if (!match) return null;
	const amount = Number(match[1]);
	const ms = amount * UNIT_MS[(match[2] || "s").toLowerCase()];
	return ms > 0 ? ms : null;
};

/** The environment variable as a duration, or the fallback when it is unset or invalid (with a warning). */
export const durationFromEnv = (name: string, fallback: string, warn: (message: string) => void = () => {}) => {
	const raw = process.env[name];
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = parseDuration(raw);
		if (parsed !== null) return parsed;
		warn(`${name}="${raw}" is not a valid duration; using ${fallback}.`);
	}
	return parseDuration(fallback) as number;
};
