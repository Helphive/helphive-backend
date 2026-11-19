// Alert rules: the kinds, input validation, evaluation over a window of measurements, the alert lifecycle, and the
// replay of a rule over recent per-minute data for the rule editor's preview. Pure; the runtime that gathers the
// measurements and stores alerts is lib/observability/alerts.ts.
import { mergeHistograms, percentile, type Histogram } from "./histogram";

export const ALERT_KINDS = {
	error_rate: {
		label: "Error rate",
		description: "Share of requests answered with a 5xx status over the window is above the threshold (percent).",
		unit: "%",
	},
	latency: {
		label: "Latency",
		description: "The chosen latency percentile over the window is above the threshold (milliseconds).",
		unit: "ms",
	},
	webhook_failures: {
		label: "Webhook failures",
		description: "Stripe webhook deliveries that failed within the window reach the threshold.",
		unit: "failures",
	},
	task_failures: {
		label: "Background task failures",
		description: "Cloud Tasks runs that failed or were refused within the window reach the threshold.",
		unit: "failures",
	},
	dependency_down: {
		label: "Dependency down",
		description: "A dependency (or the chosen one) has been down for at least the window.",
		unit: "minutes",
	},
	failed_sign_ins: {
		label: "Failed sign-ins",
		description: "Failed customer, provider and admin sign-ins within the window reach the threshold.",
		unit: "sign-ins",
	},
	rate_limited: {
		label: "Rate-limit hits",
		description: "Requests refused with 429 within the window reach the threshold.",
		unit: "requests",
	},
	new_error_group: {
		label: "New error group",
		description: "An error never seen before appeared within the window (optionally only in the newest release).",
		unit: "groups",
	},
} as const;

export type AlertKind = keyof typeof ALERT_KINDS;
export const ALERT_KIND_NAMES = Object.keys(ALERT_KINDS) as AlertKind[];
export const ALERT_SEVERITIES = ["warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export interface AlertRuleInput {
	name: string;
	kind: AlertKind;
	enabled: boolean;
	threshold: number;
	minutes: number;
	percentile?: 50 | 95 | 99;
	minRequests?: number;
	route?: string | null;
	dependency?: string | null;
	newReleaseOnly?: boolean;
	severity: AlertSeverity;
	recipients: string[];
	/** Minutes before a resolved alert of this rule may fire again. */
	cooldownMinutes: number;
}

export class RuleInputError extends Error {
	constructor(
		message: string,
		readonly field: string,
	) {
		super(message);
	}
}

const OBJECT_ID = /^[a-f\d]{24}$/i;
const ROUTE = /^\/[A-Za-z0-9_\-/:.*()]{0,199}$/;
const DEPENDENCY = /^[a-z][a-z0-9-]{1,30}$/;

const num = (value: unknown, field: string, min: number, max: number, integer = false) => {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
		throw new RuleInputError(
			`${field} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`,
			field,
		);
	}
	return n;
};

const bool = (value: unknown, field: string) => {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	throw new RuleInputError(`${field} must be true or false.`, field);
};

const DEFAULT_THRESHOLDS: Record<AlertKind, number> = {
	error_rate: 5,
	latency: 2000,
	webhook_failures: 1,
	task_failures: 1,
	dependency_down: 1,
	failed_sign_ins: 50,
	rate_limited: 100,
	new_error_group: 1,
};

/**
 * A full rule from a request body. With `partial`, missing fields come from `base` (an update). Throws RuleInputError
 * (400) naming the field.
 */
export const parseRuleInput = (body: unknown, base?: AlertRuleInput): AlertRuleInput => {
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new RuleInputError("Send the rule as JSON.", "body");
	const input = body as Record<string, unknown>;
	const allowed = new Set([
		"name",
		"kind",
		"enabled",
		"threshold",
		"minutes",
		"percentile",
		"minRequests",
		"route",
		"dependency",
		"newReleaseOnly",
		"severity",
		"recipients",
		"cooldownMinutes",
		"reason",
	]);
	for (const key of Object.keys(input)) if (!allowed.has(key)) throw new RuleInputError(`Unknown field ${key}.`, key);
	const has = (key: string) => input[key] !== undefined;

	const kind = (has("kind") ? input.kind : base?.kind) as AlertKind;
	if (!ALERT_KIND_NAMES.includes(kind))
		throw new RuleInputError(`kind must be one of: ${ALERT_KIND_NAMES.join(", ")}.`, "kind");
	if (base && has("kind") && kind !== base.kind) throw new RuleInputError("A rule's kind cannot change.", "kind");

	const nameValue = has("name") ? input.name : base?.name;
	if (typeof nameValue !== "string" || nameValue.trim().length < 3 || nameValue.trim().length > 100) {
		throw new RuleInputError("Name the rule (3 to 100 characters).", "name");
	}

	const thresholdMax = kind === "error_rate" ? 100 : kind === "latency" ? 120_000 : 1_000_000;
	const threshold = num(
		has("threshold") ? input.threshold : (base?.threshold ?? DEFAULT_THRESHOLDS[kind]),
		"threshold",
		kind === "error_rate" ? 0.1 : 1,
		thresholdMax,
		kind !== "error_rate",
	);
	const minutes = num(has("minutes") ? input.minutes : (base?.minutes ?? 5), "minutes", 1, 1440, true);
	const severityValue = has("severity") ? input.severity : (base?.severity ?? "warning");
	if (!(ALERT_SEVERITIES as readonly unknown[]).includes(severityValue)) {
		throw new RuleInputError("severity must be warning or critical.", "severity");
	}
	const recipientsValue = has("recipients") ? input.recipients : (base?.recipients ?? []);
	if (
		!Array.isArray(recipientsValue) ||
		recipientsValue.length > 20 ||
		!recipientsValue.every((id) => typeof id === "string" && OBJECT_ID.test(id))
	) {
		throw new RuleInputError("recipients must be a list of up to 20 admin ids.", "recipients");
	}
	const rule: AlertRuleInput = {
		name: nameValue.trim(),
		kind,
		enabled: has("enabled") ? bool(input.enabled, "enabled") : (base?.enabled ?? false),
		threshold,
		minutes,
		severity: severityValue as AlertSeverity,
		recipients: [...new Set(recipientsValue as string[])],
		cooldownMinutes: num(
			has("cooldownMinutes") ? input.cooldownMinutes : (base?.cooldownMinutes ?? 30),
			"cooldownMinutes",
			0,
			1440,
			true,
		),
	};
	if (kind === "latency") {
		const p = Number(has("percentile") ? input.percentile : (base?.percentile ?? 95));
		if (![50, 95, 99].includes(p)) throw new RuleInputError("percentile must be 50, 95 or 99.", "percentile");
		rule.percentile = p as 50 | 95 | 99;
	}
	if (kind === "error_rate" || kind === "latency") {
		rule.minRequests = num(
			has("minRequests") ? input.minRequests : (base?.minRequests ?? 20),
			"minRequests",
			1,
			100_000,
			true,
		);
		const route = has("route") ? input.route : (base?.route ?? null);
		if (route !== null && route !== "" && (typeof route !== "string" || !ROUTE.test(route))) {
			throw new RuleInputError("route must be a route pattern such as /admin/users/:id.", "route");
		}
		rule.route = route ? (route as string) : null;
	}
	if (kind === "dependency_down") {
		const dependency = has("dependency") ? input.dependency : (base?.dependency ?? null);
		if (
			dependency !== null &&
			dependency !== "" &&
			(typeof dependency !== "string" || !DEPENDENCY.test(dependency))
		) {
			throw new RuleInputError("dependency must be a dependency name, or empty for any.", "dependency");
		}
		rule.dependency = dependency ? (dependency as string) : null;
	}
	if (kind === "new_error_group") {
		rule.newReleaseOnly = has("newReleaseOnly")
			? bool(input.newReleaseOnly, "newReleaseOnly")
			: (base?.newReleaseOnly ?? true);
	}
	return rule;
};

/** What the evaluator measured over one rule's window. */
export interface WindowMeasures {
	requests?: number;
	errors?: number;
	rateLimited?: number;
	histogram?: Histogram;
	maxMs?: number | null;
	webhookFailures?: number;
	taskFailures?: number;
	failedSignIns?: number;
	/** Minutes each dependency has been down without a break, up to now (0 when up). */
	dependencyDownMinutes?: Record<string, number>;
	newErrorGroups?: number;
}

export interface Evaluation {
	breached: boolean;
	value: number | null;
	summary: string;
}

type RuleLike = Pick<AlertRuleInput, "kind" | "threshold" | "minutes"> & Partial<AlertRuleInput>;

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

export const evaluateRule = (rule: RuleLike, m: WindowMeasures): Evaluation => {
	const window = `${rule.minutes} min`;
	switch (rule.kind) {
		case "error_rate": {
			const requests = m.requests ?? 0;
			if (requests < (rule.minRequests ?? 1)) {
				return {
					breached: false,
					value: null,
					summary: `Too few requests (${requests}) in ${window} to judge.`,
				};
			}
			const rate = (100 * (m.errors ?? 0)) / requests;
			return {
				breached: rate > rule.threshold,
				value: round(rate, 2),
				summary: `${round(rate, 2)}% of ${requests} requests failed with 5xx in ${window} (limit ${rule.threshold}%).`,
			};
		}
		case "latency": {
			const requests = m.requests ?? 0;
			if (requests < (rule.minRequests ?? 1)) {
				return {
					breached: false,
					value: null,
					summary: `Too few requests (${requests}) in ${window} to judge.`,
				};
			}
			const p = rule.percentile ?? 95;
			const value = percentile(m.histogram, p, m.maxMs);
			return {
				breached: value !== null && value > rule.threshold,
				value,
				summary: `p${p} latency ${value ?? "?"} ms over ${window} (limit ${rule.threshold} ms).`,
			};
		}
		case "webhook_failures":
		case "task_failures":
		case "failed_sign_ins":
		case "rate_limited":
		case "new_error_group": {
			const value =
				rule.kind === "webhook_failures"
					? (m.webhookFailures ?? 0)
					: rule.kind === "task_failures"
						? (m.taskFailures ?? 0)
						: rule.kind === "failed_sign_ins"
							? (m.failedSignIns ?? 0)
							: rule.kind === "rate_limited"
								? (m.rateLimited ?? 0)
								: (m.newErrorGroups ?? 0);
			const what = {
				webhook_failures: "failed webhook deliveries",
				task_failures: "failed task runs",
				failed_sign_ins: "failed sign-ins",
				rate_limited: "requests refused with 429",
				new_error_group: "new error groups",
			}[rule.kind];
			return {
				breached: value >= rule.threshold,
				value,
				summary: `${value} ${what} in ${window} (limit ${rule.threshold}).`,
			};
		}
		case "dependency_down": {
			const entries = Object.entries(m.dependencyDownMinutes ?? {}).filter(
				([name]) => !rule.dependency || name === rule.dependency,
			);
			const down = entries.filter(([, minutes]) => minutes >= rule.minutes);
			const longest = entries.reduce((max, [, minutes]) => Math.max(max, minutes), 0);
			return {
				breached: down.length > 0,
				value: longest,
				summary: down.length
					? `Down for at least ${rule.minutes} min: ${down.map(([name]) => name).join(", ")}.`
					: `No dependency${rule.dependency ? ` (${rule.dependency})` : ""} down for ${rule.minutes} min.`,
			};
		}
		default:
			return { breached: false, value: null, summary: "Unknown rule kind." };
	}
};

export type AlertStatus = "firing" | "acknowledged" | "resolved";

/**
 * What to do after an evaluation: open a new alert, resolve the open one, or nothing. An open alert (firing or
 * acknowledged) is resolved as soon as the condition clears; a new one opens only after the cooldown since the last
 * resolution.
 */
export const alertTransition = (
	open: { status: AlertStatus } | null,
	breached: boolean,
	lastResolvedAt: Date | null,
	cooldownMinutes: number,
	now: Date,
): "open" | "resolve" | "none" => {
	if (open && open.status !== "resolved") return breached ? "none" : "resolve";
	if (!breached) return "none";
	if (lastResolvedAt && now.getTime() - lastResolvedAt.getTime() < cooldownMinutes * 60_000) return "none";
	return "open";
};

/** One minute of measurements, for the preview. */
export interface MinuteMeasures {
	requests: number;
	errors: number;
	rateLimited: number;
	histogram?: Histogram;
	maxMs?: number;
	webhookFailures: number;
	taskFailures: number;
	failedSignIns: number;
	newErrorGroups: number;
	/** Dependencies seen down in this minute (absent: no check that minute, assumed unchanged). */
	down?: Record<string, boolean>;
}

export interface Simulation {
	evaluatedMinutes: number;
	firingMinutes: number;
	/** Separate firings: rising edges, respecting the cooldown. */
	episodes: number;
	firstFiredAt: number | null;
	lastFiredAt: number | null;
	/** Minute indexes where an alert would have opened. */
	openedAt: number[];
}

/** Replays a rule over consecutive minutes (oldest first): how often it would have fired. */
export const simulateRule = (rule: RuleLike, minutes: MinuteMeasures[]): Simulation => {
	const result: Simulation = {
		evaluatedMinutes: minutes.length,
		firingMinutes: 0,
		episodes: 0,
		firstFiredAt: null,
		lastFiredAt: null,
		openedAt: [],
	};
	const span = Math.max(1, rule.minutes);
	const downRun: Record<string, number> = {};
	const knownDown: Record<string, boolean> = {};
	let open = false;
	let lastResolved: number | null = null;
	for (let i = 0; i < minutes.length; i++) {
		const current = minutes[i];
		for (const [name, isDown] of Object.entries(current.down ?? {})) knownDown[name] = isDown;
		for (const name of Object.keys(knownDown)) downRun[name] = knownDown[name] ? (downRun[name] ?? 0) + 1 : 0;
		const window = minutes.slice(Math.max(0, i - span + 1), i + 1);
		const measures: WindowMeasures = {
			requests: window.reduce((s, m) => s + m.requests, 0),
			errors: window.reduce((s, m) => s + m.errors, 0),
			rateLimited: window.reduce((s, m) => s + m.rateLimited, 0),
			webhookFailures: window.reduce((s, m) => s + m.webhookFailures, 0),
			taskFailures: window.reduce((s, m) => s + m.taskFailures, 0),
			failedSignIns: window.reduce((s, m) => s + m.failedSignIns, 0),
			newErrorGroups: window.reduce((s, m) => s + m.newErrorGroups, 0),
			dependencyDownMinutes: { ...downRun },
		};
		if (rule.kind === "latency") {
			measures.histogram = mergeHistograms(...window.map((m) => m.histogram));
			measures.maxMs = window.reduce((max, m) => Math.max(max, m.maxMs ?? 0), 0) || null;
		}
		const { breached } = evaluateRule(rule, measures);
		if (breached) result.firingMinutes++;
		const cooldown = rule.cooldownMinutes ?? 0;
		if (breached && !open && (lastResolved === null || i - lastResolved >= cooldown)) {
			open = true;
			result.episodes++;
			result.openedAt.push(i);
			result.firstFiredAt ??= i;
			result.lastFiredAt = i;
		} else if (!breached && open) {
			open = false;
			lastResolved = i;
		} else if (breached && open) {
			result.lastFiredAt = i;
		}
	}
	return result;
};

/** Rules created (disabled) the first time the evaluator runs, keyed so they are created once. */
export const DEFAULT_RULES: (Omit<AlertRuleInput, "recipients"> & { key: string })[] = [
	{
		key: "default-error-rate",
		name: "Error rate above 5% for 5 minutes",
		kind: "error_rate",
		enabled: false,
		threshold: 5,
		minutes: 5,
		minRequests: 20,
		route: null,
		severity: "critical",
		cooldownMinutes: 30,
	},
	{
		key: "default-latency-p95",
		name: "p95 latency above 2 seconds for 10 minutes",
		kind: "latency",
		enabled: false,
		threshold: 2000,
		minutes: 10,
		percentile: 95,
		minRequests: 20,
		route: null,
		severity: "warning",
		cooldownMinutes: 30,
	},
	{
		key: "default-webhook-failure",
		name: "A Stripe webhook failed",
		kind: "webhook_failures",
		enabled: false,
		threshold: 1,
		minutes: 15,
		severity: "warning",
		cooldownMinutes: 60,
	},
	{
		key: "default-task-failure",
		name: "A background task failed",
		kind: "task_failures",
		enabled: false,
		threshold: 1,
		minutes: 15,
		severity: "warning",
		cooldownMinutes: 60,
	},
	{
		key: "default-dependency-down",
		name: "A dependency down for 5 minutes",
		kind: "dependency_down",
		enabled: false,
		threshold: 1,
		minutes: 5,
		dependency: null,
		severity: "critical",
		cooldownMinutes: 30,
	},
	{
		key: "default-failed-sign-ins",
		name: "Spike in failed sign-ins (50 in 15 minutes)",
		kind: "failed_sign_ins",
		enabled: false,
		threshold: 50,
		minutes: 15,
		severity: "warning",
		cooldownMinutes: 60,
	},
	{
		key: "default-rate-limited",
		name: "Spike in rate-limit hits (100 in 15 minutes)",
		kind: "rate_limited",
		enabled: false,
		threshold: 100,
		minutes: 15,
		severity: "warning",
		cooldownMinutes: 60,
	},
	{
		key: "default-new-error-group",
		name: "New error in the newest release",
		kind: "new_error_group",
		enabled: false,
		threshold: 1,
		minutes: 30,
		newReleaseOnly: true,
		severity: "warning",
		cooldownMinutes: 60,
	},
];
