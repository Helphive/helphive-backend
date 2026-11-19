// Platform settings the console and the apps show: the Stripe mode (from the secret key's prefix, never the key) and
// how long after completion a provider's earning is released. EARNINGS_RELEASE_DELAY_SECONDS defaults to 30, today's
// test-mode behaviour.

const intIn = (value: string | undefined, fallback: number, min: number, max: number) => {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

export const DEFAULT_RELEASE_DELAY_SECONDS = 30;
const MAX_RELEASE_DELAY_SECONDS = 30 * 24 * 60 * 60;

export const earningsReleaseDelaySeconds = (env: NodeJS.ProcessEnv = process.env) =>
	intIn(env.EARNINGS_RELEASE_DELAY_SECONDS, DEFAULT_RELEASE_DELAY_SECONDS, 0, MAX_RELEASE_DELAY_SECONDS);

export type StripeMode = "test" | "live" | "unknown";

export const stripeMode = (secretKey: string | undefined = process.env.STRIPE_SECRET_KEY): StripeMode => {
	if (!secretKey) return "unknown";
	if (/^(sk|rk)_live_/.test(secretKey)) return "live";
	if (/^(sk|rk)_test_/.test(secretKey)) return "test";
	return "unknown";
};

/** "30 seconds", "1 hour", "3 days". */
export const describeDelay = (seconds: number) => {
	const units: [number, string][] = [
		[86400, "day"],
		[3600, "hour"],
		[60, "minute"],
		[1, "second"],
	];
	if (seconds <= 0) return "immediately";
	for (const [size, name] of units) {
		if (seconds >= size && seconds % size === 0) {
			const count = seconds / size;
			return `${count} ${name}${count === 1 ? "" : "s"}`;
		}
	}
	return `${seconds} seconds`;
};

export const releasePolicy = (env: NodeJS.ProcessEnv = process.env) => {
	const delaySeconds = earningsReleaseDelaySeconds(env);
	const mode = stripeMode(env.STRIPE_SECRET_KEY);
	const testMode = mode !== "live";
	const when = delaySeconds <= 0 ? "immediately after completion" : `${describeDelay(delaySeconds)} after completion`;
	return {
		delaySeconds,
		stripeMode: mode,
		testMode,
		notice: testMode
			? `Test mode: provider earnings are released ${when}.`
			: `Provider earnings are released ${when}.`,
	};
};
