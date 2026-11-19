// Risk rules: conditions over signals with thresholds, a weight, a severity, actions and a mode. Pure: validation,
// evaluation, score explanation and the default rule pack. Stored in riskrules (dal/models/risk.model.ts); the engine
// (lib/risk/engine.ts) evaluates them when relevant events happen.
import { SIGNAL_BY_KEY, isSignalKey, type EvidenceRefs, type EvidenceValues, type SignalResult } from "./signals";

export const RULE_MODES = ["off", "observe", "enforce"] as const;
export type RuleMode = (typeof RULE_MODES)[number];

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RULE_ACTIONS = ["score", "open_case", "hold_payouts", "review_before_payout", "suspend"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const RULE_ACTION_LABELS: Record<RuleAction, string> = {
	score: "Add the weight to the risk score",
	open_case: "Open a review case",
	hold_payouts: "Hold the provider's payouts and earning releases",
	review_before_payout: "Require a review before the provider's next payout",
	suspend: "Suspend the account",
};

export const OPERATORS = ["gte", "gt", "lte", "lt", "eq"] as const;
export type Operator = (typeof OPERATORS)[number];
export const OPERATOR_SYMBOLS: Record<Operator, string> = { gte: "≥", gt: ">", lte: "≤", lt: "<", eq: "=" };

export interface RuleCondition {
	signal: string;
	op: Operator;
	value: number;
}

export interface RuleDefinition {
	key: string;
	title: string;
	explanation: string;
	match: "all" | "any";
	conditions: RuleCondition[];
	/** Points added to the score when the rule fires (0-100). */
	weight: number;
	severity: Severity;
	actions: RuleAction[];
	mode: RuleMode;
}

export const MAX_CONDITIONS = 5;
export const MAX_SCORE = 100;

export class RuleValidationError extends Error {
	constructor(
		message: string,
		readonly field: string,
	) {
		super(message);
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, field: string, min: number, max: number) => {
	if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
		throw new RuleValidationError(`${field} must be ${min} to ${max} characters.`, field);
	}
	return value.trim();
};

/**
 * Checks a full rule (create, draft for a backtest) or a partial one (update; `partial` keeps absent fields out).
 * Returns the cleaned fields; throws RuleValidationError with the first problem.
 */
export const validateRule = (input: unknown, partial = false): Partial<RuleDefinition> => {
	if (!isRecord(input)) throw new RuleValidationError("Send the rule as a JSON object.", "rule");
	const allowed = new Set([
		"key",
		"title",
		"explanation",
		"match",
		"conditions",
		"weight",
		"severity",
		"actions",
		"mode",
	]);
	for (const field of Object.keys(input)) {
		if (!allowed.has(field)) throw new RuleValidationError(`Unknown field ${field}.`, field);
	}
	const out: Partial<RuleDefinition> = {};
	const has = (field: string) => input[field] !== undefined;
	const need = (field: string) => {
		if (!partial && !has(field)) throw new RuleValidationError(`${field} is required.`, field);
		return has(field);
	};
	if (has("key")) {
		if (typeof input.key !== "string" || !/^[a-z][a-z0-9_]{2,49}$/.test(input.key)) {
			throw new RuleValidationError("key must be 3 to 50 lower-case letters, digits or _.", "key");
		}
		out.key = input.key;
	}
	if (need("title")) out.title = text(input.title, "title", 3, 80);
	if (has("explanation")) out.explanation = text(input.explanation, "explanation", 0, 500);
	else if (!partial) out.explanation = "";
	if (has("match") || !partial) {
		const match = input.match ?? "all";
		if (match !== "all" && match !== "any") throw new RuleValidationError("match must be all or any.", "match");
		out.match = match;
	}
	if (need("conditions")) {
		const conditions = input.conditions;
		if (!Array.isArray(conditions) || conditions.length < 1 || conditions.length > MAX_CONDITIONS) {
			throw new RuleValidationError(`conditions must list 1 to ${MAX_CONDITIONS} conditions.`, "conditions");
		}
		out.conditions = conditions.map((condition, i) => {
			const field = `conditions[${i}]`;
			if (!isRecord(condition)) throw new RuleValidationError(`${field} must be an object.`, field);
			if (!isSignalKey(condition.signal)) {
				throw new RuleValidationError(`${field}.signal is not a known signal.`, `${field}.signal`);
			}
			if (!(OPERATORS as readonly unknown[]).includes(condition.op)) {
				throw new RuleValidationError(`${field}.op must be one of ${OPERATORS.join(", ")}.`, `${field}.op`);
			}
			const value = condition.value;
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
				throw new RuleValidationError(`${field}.value must be a number from 0 to 1000000.`, `${field}.value`);
			}
			return { signal: condition.signal, op: condition.op as Operator, value };
		});
	}
	if (need("weight")) {
		const weight = input.weight;
		if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 0 || weight > MAX_SCORE) {
			throw new RuleValidationError(`weight must be a whole number from 0 to ${MAX_SCORE}.`, "weight");
		}
		out.weight = weight;
	}
	if (need("severity")) {
		if (!(SEVERITIES as readonly unknown[]).includes(input.severity)) {
			throw new RuleValidationError(`severity must be one of ${SEVERITIES.join(", ")}.`, "severity");
		}
		out.severity = input.severity as Severity;
	}
	if (need("actions")) {
		const actions = input.actions;
		if (!Array.isArray(actions) || actions.some((a) => !(RULE_ACTIONS as readonly unknown[]).includes(a))) {
			throw new RuleValidationError(`actions must be a list of: ${RULE_ACTIONS.join(", ")}.`, "actions");
		}
		const unique = [...new Set(actions as RuleAction[])];
		if (!unique.includes("score")) unique.unshift("score");
		out.actions = RULE_ACTIONS.filter((a) => unique.includes(a));
	}
	if (has("mode") || !partial) {
		const mode = input.mode ?? "observe";
		if (!(RULE_MODES as readonly unknown[]).includes(mode)) {
			throw new RuleValidationError(`mode must be one of ${RULE_MODES.join(", ")}.`, "mode");
		}
		out.mode = mode as RuleMode;
	}
	return out;
};

export const compare = (value: number, op: Operator, threshold: number) => {
	switch (op) {
		case "gte":
			return value >= threshold;
		case "gt":
			return value > threshold;
		case "lte":
			return value <= threshold;
		case "lt":
			return value < threshold;
		case "eq":
			return value === threshold;
	}
};

export interface ConditionEvidence {
	signal: string;
	label: string;
	op: Operator;
	threshold: number;
	value: number | null;
	met: boolean;
	explanation: string;
	values?: EvidenceValues;
	refs?: EvidenceRefs;
}

export interface RuleHit {
	ruleKey: string;
	title: string;
	weight: number;
	severity: Severity;
	mode: RuleMode;
	actions: RuleAction[];
	evidence: ConditionEvidence[];
}

/** The signals a rule needs. */
export const signalsOf = (rules: readonly Pick<RuleDefinition, "conditions">[]) => [
	...new Set(rules.flatMap((rule) => rule.conditions.map((c) => c.signal))),
];

/** Whether a rule fires on these signal values, with the evidence for each condition. Mode "off" never fires. */
export const evaluateRule = (rule: RuleDefinition, signals: Record<string, SignalResult>): RuleHit | null => {
	if (rule.mode === "off") return null;
	const evidence = rule.conditions.map((condition): ConditionEvidence => {
		const result = signals[condition.signal];
		const value = result?.value ?? null;
		return {
			signal: condition.signal,
			label: SIGNAL_BY_KEY.get(condition.signal)?.label ?? condition.signal,
			op: condition.op,
			threshold: condition.value,
			value,
			met: value !== null && compare(value, condition.op, condition.value),
			explanation: result?.explanation ?? "Not computed.",
			...(result?.values ? { values: result.values } : {}),
			...(result?.refs ? { refs: result.refs } : {}),
		};
	});
	const fired = rule.match === "any" ? evidence.some((e) => e.met) : evidence.every((e) => e.met);
	if (!fired) return null;
	return {
		ruleKey: rule.key,
		title: rule.title,
		weight: rule.weight,
		severity: rule.severity,
		mode: rule.mode,
		actions: rule.actions,
		evidence,
	};
};

export const scoreBand = (score: number): Severity =>
	score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "medium" : "low";

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const maxSeverity = (severities: Severity[]): Severity =>
	severities.reduce<Severity>((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a), "low");
export const severityRank = (severity: Severity) => SEVERITY_RANK[severity];

export interface ScoreExplanation {
	score: number;
	band: Severity;
	/** Rules that fired, heaviest first, with what each added (the total is capped at 100). */
	contributions: (RuleHit & { points: number })[];
	explanation: string;
}

/**
 * The score is the sum of the weights of the rules that fired (observe and enforce alike: the score itself blocks
 * nothing), capped at 100. Each contribution says how many points it added after the cap.
 */
export const explainScore = (hits: readonly RuleHit[]): ScoreExplanation => {
	const sorted = [...hits].sort(
		(a, b) =>
			b.weight - a.weight ||
			severityRank(b.severity) - severityRank(a.severity) ||
			(a.ruleKey < b.ruleKey ? -1 : 1),
	);
	let remaining = MAX_SCORE;
	const contributions = sorted.map((hit) => {
		const points = Math.min(hit.weight, remaining);
		remaining -= points;
		return { ...hit, points };
	});
	const score = MAX_SCORE - remaining;
	const band = scoreBand(score);
	const explanation = contributions.length
		? `${score} of 100 from ${contributions.length} rule${contributions.length === 1 ? "" : "s"}: ${contributions
				.filter((c) => c.points > 0)
				.map((c) => `${c.title} (+${c.points})`)
				.join(", ")}.`
		: "No rule fired: score 0.";
	return { score, band, contributions, explanation };
};

/** Actions to carry out: enforce-mode hits only; observe-mode hits list what they would have done. */
export const plannedActions = (hits: readonly RuleHit[]) => {
	const take = new Set<RuleAction>();
	const wouldTake = new Set<RuleAction>();
	for (const hit of hits) {
		for (const action of hit.actions) {
			if (action === "score") continue;
			if (hit.mode === "enforce") take.add(action);
			else wouldTake.add(action);
		}
	}
	return { take: RULE_ACTIONS.filter((a) => take.has(a)), wouldTake: RULE_ACTIONS.filter((a) => wouldTake.has(a)) };
};

// --- Default rule pack -------------------------------------------------------------------------------------------

type DefaultRule = Omit<RuleDefinition, "mode">;

const rule = (
	key: string,
	title: string,
	explanation: string,
	conditions: [string, Operator, number][],
	weight: number,
	severity: Severity,
	actions: RuleAction[],
	match: "all" | "any" = "all",
): DefaultRule => ({
	key,
	title,
	explanation,
	match,
	conditions: conditions.map(([signal, op, value]) => ({ signal, op, value })),
	weight,
	severity,
	actions: ["score", ...actions.filter((a) => a !== "score")],
});

/** Created enabled in observe mode: they score and record hits, and block nothing until an admin enforces them. */
export const DEFAULT_RULES: readonly DefaultRule[] = [
	rule(
		"shared_device",
		"Device shared by several accounts",
		"Two or more other accounts used the same device in 90 days: multi-accounting or one person on both sides of a booking.",
		[["shared_device_accounts", "gte", 2]],
		25,
		"medium",
		["open_case"],
	),
	rule(
		"shared_phone",
		"Phone number on another account",
		"Another account has the same phone number.",
		[["shared_phone_accounts", "gte", 1]],
		20,
		"medium",
		["open_case"],
	),
	rule(
		"shared_payout_destination",
		"Payout bank details on another provider",
		"Two providers paying out to the same bank details usually means one person behind both.",
		[["shared_payout_destination_accounts", "gte", 1]],
		35,
		"high",
		["open_case", "hold_payouts"],
	),
	rule(
		"shared_booking_address",
		"Address booked by several customers",
		"Three or more other customer accounts booked the same address in 180 days.",
		[["shared_booking_address_accounts", "gte", 3]],
		10,
		"low",
		[],
	),
	rule(
		"shared_network",
		"Network shared by many accounts",
		"Five or more other accounts on the same IP addresses in 30 days. Hotels share networks, so this only adds to the score.",
		[["shared_ip_accounts", "gte", 5]],
		10,
		"low",
		[],
	),
	rule(
		"many_sign_in_devices",
		"Signed in from many devices",
		"Four or more devices signed in to the account in 24 hours.",
		[["sign_in_devices_24h", "gte", 4]],
		15,
		"medium",
		["open_case"],
	),
	rule(
		"sign_in_address_hopping",
		"Signed in from many addresses",
		"Four or more IP addresses tried this account within an hour.",
		[["sign_in_ips_1h", "gte", 4]],
		15,
		"medium",
		[],
	),
	rule(
		"failed_sign_in_burst",
		"Burst of failed sign-ins",
		"Ten or more failed sign-ins in an hour: password guessing.",
		[["sign_in_failures_1h", "gte", 10]],
		10,
		"low",
		[],
	),
	rule(
		"booking_velocity",
		"Many bookings in a day",
		"Ten or more bookings created in 24 hours.",
		[["bookings_created_24h", "gte", 10]],
		15,
		"medium",
		["open_case"],
	),
	rule(
		"payment_velocity",
		"Many payments in a day",
		"Eight or more payments in 24 hours.",
		[["payments_succeeded_24h", "gte", 8]],
		10,
		"low",
		[],
	),
	rule(
		"payment_failures",
		"Repeated failed payments",
		"Three or more failed payments in 24 hours: card testing.",
		[["payment_failures_24h", "gte", 3]],
		20,
		"medium",
		["open_case"],
	),
	rule(
		"card_switching",
		"Several cards tried",
		"Three or more different cards in 7 days.",
		[["distinct_cards_7d", "gte", 3]],
		25,
		"high",
		["open_case"],
	),
	rule(
		"cancellation_velocity",
		"Many cancellations in a day",
		"Five or more cancellations made in 24 hours.",
		[["cancellations_24h", "gte", 5]],
		10,
		"low",
		[],
	),
	rule(
		"refund_velocity",
		"Many refunds in a week",
		"Three or more refunds on the customer's payments in 7 days.",
		[["refunds_7d", "gte", 3]],
		15,
		"medium",
		["open_case"],
	),
	rule(
		"payout_velocity",
		"Many payout requests in a day",
		"Three or more payout requests in 24 hours.",
		[["payout_requests_24h", "gte", 3]],
		15,
		"medium",
		["review_before_payout"],
	),
	rule(
		"new_account_large_booking",
		"Large booking from a new account",
		"First booking of $300 or more within 24 hours of sign-up.",
		[["account_age_at_first_large_booking_hours", "lt", 24]],
		15,
		"medium",
		[],
	),
	rule(
		"new_provider_fast_payout",
		"Payout soon after sign-up",
		"First payout requested within 72 hours of the provider signing up.",
		[["account_age_at_first_payout_hours", "lt", 72]],
		20,
		"medium",
		["review_before_payout"],
	),
	rule(
		"repeat_pairing",
		"Same customer and provider again and again",
		"Five or more bookings between the same customer and provider in 30 days.",
		[["repeat_pair_bookings_30d", "gte", 5]],
		15,
		"medium",
		["open_case"],
	),
	rule(
		"collusive_fast_completions",
		"Fast completions with the same counterparty",
		"Two or more jobs with the same counterparty completed in under half the booked time: paid for work that may not have happened.",
		[["repeat_pair_fast_completions_30d", "gte", 2]],
		35,
		"high",
		["open_case", "hold_payouts"],
	),
	rule(
		"far_from_job",
		"Started or completed far from the job",
		"The provider's position was 5 km or more from the booking when a job started or completed.",
		[["start_far_from_booking_km", "gte", 5]],
		25,
		"high",
		["open_case"],
	),
	rule(
		"fast_completions",
		"Jobs completed much faster than booked",
		"Three or more jobs completed in under half the booked hours in 30 days.",
		[["fast_completions_30d", "gte", 3]],
		20,
		"medium",
		["open_case"],
	),
	rule(
		"cancel_after_accept",
		"Cancellations after acceptance",
		"Three or more bookings cancelled after a provider accepted, in 30 days.",
		[["cancellations_after_acceptance_30d", "gte", 3]],
		15,
		"medium",
		[],
	),
	rule(
		"refund_after_accept",
		"Refunds after acceptance",
		"Two or more accepted bookings refunded in 30 days.",
		[["refunds_after_acceptance_30d", "gte", 2]],
		15,
		"medium",
		["open_case"],
	),
	rule(
		"blocked_signups_nearby",
		"Blocked sign-ups from the same device or network",
		"Three or more sign-ups refused by the email policy came from this account's devices or addresses in 7 days.",
		[["signup_blocked_attempts_7d", "gte", 3]],
		15,
		"medium",
		[],
	),
	rule(
		"stripe_elevated_risk",
		"Stripe rated a charge risky",
		"Stripe Radar rated a charge elevated or highest risk, or blocked it or sent it to review.",
		[["stripe_elevated_risk_charges_30d", "gte", 1]],
		30,
		"high",
		["open_case"],
	),
	rule(
		"stripe_high_score",
		"High Stripe risk score",
		"A charge scored 75 or more by Stripe Radar (only on accounts that receive scores).",
		[["stripe_max_risk_score_30d", "gte", 75]],
		30,
		"high",
		["open_case"],
	),
	rule(
		"payout_ring",
		"Shared payout details and collusive jobs",
		"Bank details shared with another provider and fast completions with a repeat counterparty: a payout ring.",
		[
			["shared_payout_destination_accounts", "gte", 1],
			["repeat_pair_fast_completions_30d", "gte", 1],
		],
		50,
		"critical",
		["open_case", "hold_payouts", "suspend"],
	),
];

export const defaultRuleDocuments = () =>
	DEFAULT_RULES.map((definition) => ({ ...definition, mode: "observe" as RuleMode, isDefault: true }));
