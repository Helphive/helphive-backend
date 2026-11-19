// Backtest: run one rule (saved or a draft) over a past period without side effects. Pure: given a dataset and the
// moments evaluations would have happened (the trigger events), it says how often the rule would have fired, on
// whom and what it would have done. The same inputs always give the same answer.
import { computeSignals, type DatasetIndex, type RiskEvent } from "./signals";
import { evaluateRule, signalsOf, type ConditionEvidence, type RuleAction, type RuleDefinition } from "./rules";

const DAY = 24 * 60 * 60 * 1000;

/** Event types after which the live engine evaluates the people involved. */
export const TRIGGER_EVENT_TYPES = new Set([
	"user.signed_up",
	"auth.sign_in_succeeded",
	"auth.sign_in_failed",
	"user.profile_updated",
	"booking.created",
	"booking.accepted",
	"booking.started",
	"booking.completed",
	"booking.cancelled",
	"payment.succeeded",
	"payment.failed",
	"refund.created",
	"earning.created",
	"payout.requested",
	"payout.failed",
]);

/** Who an event is about, for evaluation: the person who acted plus the customer and provider named. */
export const peopleOf = (event: RiskEvent, customerOfBooking?: (bookingId: string) => string | undefined) => {
	const ids = new Set<string>();
	if ((event.actorType === "user" || event.actorType === "provider") && event.actorId) ids.add(event.actorId);
	if (event.userId) ids.add(event.userId);
	if (event.providerId) ids.add(event.providerId);
	if (!event.userId && event.bookingId && customerOfBooking) {
		const customer = customerOfBooking(event.bookingId);
		if (customer) ids.add(customer);
	}
	return [...ids].sort();
};

export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

export interface BacktestSubject {
	userId: string;
	hits: number;
	firstAt: string;
	lastAt: string;
	/** Evidence of the first time it fired. */
	evidence: ConditionEvidence[];
	/** What the rule would have done to this person (holds only apply to providers). */
	actions: RuleAction[];
}

export interface BacktestResult {
	from: string;
	to: string;
	triggers: number;
	evaluations: number;
	/** Firings, counted once per person per day as the live engine records them. */
	hits: number;
	people: number;
	byDay: { day: string; hits: number }[];
	actions: Partial<Record<RuleAction, number>>;
	subjects: BacktestSubject[];
	/** Subjects beyond this many are counted but not listed. */
	subjectLimit: number;
}

export const BACKTEST_SUBJECT_LIMIT = 50;

/**
 * Evaluates the rule (as if enforced, so the actions show) for each person named by each trigger event in
 * [from, to], as of that event. Triggers are taken in time order (ties by id), so the result is deterministic.
 */
export const runBacktest = (
	index: DatasetIndex,
	rule: RuleDefinition,
	period: { from: number; to: number },
	subjectLimit = BACKTEST_SUBJECT_LIMIT,
): BacktestResult => {
	const keys = signalsOf([rule]);
	const asEnforced: RuleDefinition = { ...rule, mode: "enforce" };
	const triggers = index.ds.events
		.filter((e) => TRIGGER_EVENT_TYPES.has(e.type) && e.at >= period.from && e.at <= period.to)
		.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const customerOf = (bookingId: string) => index.bookings.get(bookingId)?.userId;
	const seenDay = new Set<string>();
	const byDay = new Map<string, number>();
	const subjects = new Map<string, BacktestSubject>();
	let evaluations = 0;
	let hits = 0;
	for (const trigger of triggers) {
		for (const userId of peopleOf(trigger, customerOf)) {
			const day = utcDay(trigger.at);
			// The live engine records one hit per rule, person and day; skip evaluations that could only repeat it.
			if (seenDay.has(`${userId}|${day}`)) continue;
			evaluations++;
			const hit = evaluateRule(asEnforced, computeSignals(index, userId, trigger.at, keys));
			if (!hit) continue;
			seenDay.add(`${userId}|${day}`);
			hits++;
			byDay.set(day, (byDay.get(day) ?? 0) + 1);
			const at = new Date(trigger.at).toISOString();
			const existing = subjects.get(userId);
			if (existing) {
				existing.hits++;
				existing.lastAt = at;
				continue;
			}
			const isProvider = index.users.get(userId)?.isProvider ?? false;
			subjects.set(userId, {
				userId,
				hits: 1,
				firstAt: at,
				lastAt: at,
				evidence: hit.evidence,
				actions: rule.actions.filter(
					(a) => a !== "score" && (isProvider || (a !== "hold_payouts" && a !== "review_before_payout")),
				),
			});
		}
	}
	const actions: Partial<Record<RuleAction, number>> = {};
	for (const subject of subjects.values()) {
		for (const action of subject.actions) actions[action] = (actions[action] ?? 0) + 1;
	}
	const days: { day: string; hits: number }[] = [];
	for (let t = Date.parse(`${utcDay(period.from)}T00:00:00Z`); t <= period.to; t += DAY) {
		days.push({ day: utcDay(t), hits: byDay.get(utcDay(t)) ?? 0 });
	}
	return {
		from: new Date(period.from).toISOString(),
		to: new Date(period.to).toISOString(),
		triggers: triggers.length,
		evaluations,
		hits,
		people: subjects.size,
		byDay: days,
		actions,
		subjects: [...subjects.values()]
			.sort((a, b) => b.hits - a.hits || (a.userId < b.userId ? -1 : 1))
			.slice(0, subjectLimit),
		subjectLimit,
	};
};
