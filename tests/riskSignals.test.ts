// Every risk signal on a fixture dataset, rule evaluation, score explanation and the default rule pack. Pure.
import test from "node:test";
import assert from "node:assert/strict";
import {
	SIGNALS,
	computeSignals,
	indexDataset,
	signalCatalogue,
	distanceKm,
	isUsablePosition,
} from "../lib/risk/signals";
import {
	DEFAULT_RULES,
	RuleValidationError,
	evaluateRule,
	explainScore,
	plannedActions,
	scoreBand,
	validateRule,
	type RuleDefinition,
} from "../lib/risk/rules";

import { fixture, NOW, CUST, PROV, CUST3, H } from "./riskFixture";

const signalsFor = (who: string) => computeSignals(indexDataset(fixture()), who, NOW);

test("every signal is defined once, with a label, an explanation and how it is computed", () => {
	const keys = SIGNALS.map((s) => s.key);
	assert.equal(new Set(keys).size, keys.length);
	for (const signal of SIGNALS) {
		assert.ok(signal.label && signal.explanation && signal.computedFrom, signal.key);
	}
	assert.equal(signalCatalogue().length, SIGNALS.length);
	assert.ok(!("compute" in signalCatalogue()[0]));
});

test("signals for the customer: shared accounts, sign-in spread, velocity, account age, payments", () => {
	const s = signalsFor(CUST);
	assert.equal(s.shared_device_accounts.value, 2, "PROV2 (device id case ignored) and CUST2");
	assert.deepEqual(s.shared_device_accounts.values?.deviceId, ["dev-a"]);
	assert.equal(s.shared_ip_accounts.value, 1);
	assert.equal(s.shared_phone_accounts.value, 1, "the same number with a country code");
	assert.equal(s.shared_booking_address_accounts.value, 3);
	assert.equal(s.sign_in_devices_24h.value, 4);
	assert.equal(s.sign_in_ips_1h.value, 4);
	assert.equal(s.sign_in_failures_1h.value, 10);
	assert.equal(s.bookings_created_24h.value, 10);
	assert.equal(s.payments_succeeded_24h.value, 8);
	assert.equal(s.payment_failures_24h.value, 3, "customer found through the booking");
	assert.equal(s.cancellations_24h.value, 5);
	assert.equal(s.refunds_7d.value, 3);
	assert.equal(s.account_age_at_first_large_booking_hours.value, 10);
	assert.equal(s.cancellations_after_acceptance_30d.value, 3);
	assert.equal(s.refunds_after_acceptance_30d.value, 2);
	assert.equal(s.distinct_cards_7d.value, 3, "a charge found through its booking counts");
	assert.equal(s.signup_blocked_attempts_7d.value, 3, "the one older than 7 days is left out");
	assert.equal(s.stripe_elevated_risk_charges_30d.value, 2, "elevated level and a blocked outcome");
	assert.equal(s.stripe_max_risk_score_30d.value, 80);
	assert.equal(s.repeat_pair_bookings_30d.value, 8);
	assert.equal(s.repeat_pair_fast_completions_30d.value, 5);
	assert.deepEqual(s.repeat_pair_bookings_30d.refs?.userIds, [PROV]);
});

test("signals for the provider: payouts, bank details, position and fast completions", () => {
	const s = signalsFor(PROV);
	assert.equal(s.payout_requests_24h.value, 3);
	assert.equal(s.shared_payout_destination_accounts.value, 1);
	assert.deepEqual(s.shared_payout_destination_accounts.values?.last4, ["6789"]);
	assert.ok(s.account_age_at_first_payout_hours.value! < 72);
	assert.equal(s.start_far_from_booking_km.value, 7.2, "the stale 50 km fix is not used");
	assert.equal(s.fast_completions_30d.value, 5);
	assert.equal(s.repeat_pair_fast_completions_30d.value, 5);
});

test("signals with no data are null, and evaluating as of an earlier moment ignores later records", () => {
	const s = signalsFor(CUST3);
	assert.equal(s.shared_phone_accounts.value, null);
	assert.equal(s.distinct_cards_7d.value, null);
	assert.equal(s.account_age_at_first_payout_hours.value, null);
	const earlier = computeSignals(indexDataset(fixture()), CUST, NOW - 25 * H);
	assert.equal(earlier.bookings_created_24h.value, 0);
	assert.equal(earlier.account_age_at_first_large_booking_hours.value, null);
});

test("evidence text never contains the identifying values", () => {
	for (const [key, result] of Object.entries(signalsFor(CUST))) {
		assert.ok(!/203\.0\.113|dev-|7911|6789|portland/i.test(result.explanation), `${key}: ${result.explanation}`);
	}
});

test("positions: distance in km and the 0,0 placeholder", () => {
	assert.ok(Math.abs(distanceKm(53.4808, -2.2426, 53.4084, -2.9916) - 50.3) < 0.5);
	assert.equal(isUsablePosition(0, 0), false);
	assert.equal(isUsablePosition(53.4, -2.2), true);
	assert.equal(isUsablePosition(91, 0), false);
});

// --- Rules -------------------------------------------------------------------------------------------------------

const rule = (overrides: Partial<RuleDefinition> = {}): RuleDefinition => ({
	key: "t",
	title: "Test",
	explanation: "",
	match: "all",
	conditions: [{ signal: "bookings_created_24h", op: "gte", value: 10 }],
	weight: 20,
	severity: "medium",
	actions: ["score", "open_case"],
	mode: "observe",
	...overrides,
});

test("rule validation: required fields, known signals, bounds, score always included", () => {
	const valid = validateRule({
		title: "Many",
		conditions: [{ signal: "refunds_7d", op: "gt", value: 2 }],
		weight: 10,
		severity: "low",
		actions: ["open_case"],
	});
	assert.deepEqual(valid.actions, ["score", "open_case"]);
	assert.equal(valid.mode, "observe");
	const fails = (input: unknown, field: string, partial = false) =>
		assert.throws(
			() => validateRule(input, partial),
			(e: unknown) => e instanceof RuleValidationError && e.field === field,
		);
	fails({ title: "x", conditions: [], weight: 1, severity: "low", actions: [] }, "title");
	fails(
		{
			title: "Okay",
			conditions: [{ signal: "nope", op: "gt", value: 1 }],
			weight: 1,
			severity: "low",
			actions: [],
		},
		"conditions[0].signal",
	);
	fails(
		{
			title: "Okay",
			conditions: [{ signal: "refunds_7d", op: "≥", value: 1 }],
			weight: 1,
			severity: "low",
			actions: [],
		},
		"conditions[0].op",
	);
	fails(
		{
			title: "Okay",
			conditions: [{ signal: "refunds_7d", op: "gt", value: -1 }],
			weight: 1,
			severity: "low",
			actions: [],
		},
		"conditions[0].value",
	);
	fails(
		{
			title: "Okay",
			conditions: [{ signal: "refunds_7d", op: "gt", value: 1 }],
			weight: 101,
			severity: "low",
			actions: [],
		},
		"weight",
	);
	fails(
		{
			title: "Okay",
			conditions: [{ signal: "refunds_7d", op: "gt", value: 1 }],
			weight: 1,
			severity: "low",
			actions: ["delete"],
		},
		"actions",
	);
	fails({ $where: "1" }, "$where", true);
	assert.deepEqual(validateRule({ weight: 5 }, true), { weight: 5 });
	fails({ mode: "on" }, "mode", true);
});

test("rule evaluation: all, any, null values, mode off, and the evidence per condition", () => {
	const s = signalsFor(CUST);
	const hit = evaluateRule(rule(), s);
	assert.ok(hit);
	assert.equal(hit.evidence[0].value, 10);
	assert.equal(hit.evidence[0].met, true);
	assert.equal(evaluateRule(rule({ mode: "off" }), s), null);
	const both = rule({
		conditions: [
			{ signal: "bookings_created_24h", op: "gte", value: 10 },
			{ signal: "refunds_7d", op: "gt", value: 99 },
		],
	});
	assert.equal(evaluateRule(both, s), null);
	assert.ok(evaluateRule({ ...both, match: "any" }, s));
	// A null signal never satisfies a condition, even "< 24".
	assert.equal(
		evaluateRule(rule({ conditions: [{ signal: "account_age_at_first_payout_hours", op: "lt", value: 24 }] }), s),
		null,
	);
});

test("score: sum of weights capped at 100, heaviest first, each contribution after the cap", () => {
	const s = signalsFor(CUST);
	const hits = [
		rule({ key: "a", weight: 60 }),
		rule({ key: "b", weight: 50, severity: "high" }),
		rule({ key: "c", weight: 0 }),
	]
		.map((r) => evaluateRule(r, s)!)
		.filter(Boolean);
	const explained = explainScore(hits);
	assert.equal(explained.score, 100);
	assert.equal(explained.band, "critical");
	assert.deepEqual(
		explained.contributions.map((c) => [c.ruleKey, c.points]),
		[
			["a", 60],
			["b", 40],
			["c", 0],
		],
	);
	assert.match(explained.explanation, /100 of 100 from 3 rules/);
	assert.equal(explainScore([]).score, 0);
	assert.deepEqual([0, 24, 25, 50, 75].map(scoreBand), ["low", "low", "medium", "high", "critical"]);
});

test("actions: enforce-mode hits act; observe-mode hits only say what they would do", () => {
	const s = signalsFor(CUST);
	const observe = evaluateRule(rule({ actions: ["score", "hold_payouts"] }), s)!;
	const enforce = evaluateRule(rule({ mode: "enforce", actions: ["score", "open_case"] }), s)!;
	assert.deepEqual(plannedActions([observe, enforce]), { take: ["open_case"], wouldTake: ["hold_payouts"] });
});

test("the default rule pack: valid, unique keys, known signals, observe mode, covers every signal", () => {
	const keys = new Set<string>();
	const used = new Set<string>();
	for (const definition of DEFAULT_RULES) {
		assert.ok(!keys.has(definition.key), definition.key);
		keys.add(definition.key);
		validateRule({ ...definition, mode: "observe" });
		for (const c of definition.conditions) used.add(c.signal);
	}
	for (const signal of SIGNALS) assert.ok(used.has(signal.key), `${signal.key} has a default rule`);
});

test("on the fixture, the customer fires the velocity and payment rules and the provider the payout ones", () => {
	const fire = (who: string) =>
		DEFAULT_RULES.map((d) => evaluateRule({ ...d, mode: "observe" }, signalsFor(who)))
			.filter(Boolean)
			.map((h) => h!.ruleKey);
	const customer = fire(CUST);
	for (const key of [
		"shared_device",
		"shared_phone",
		"booking_velocity",
		"payment_failures",
		"card_switching",
		"stripe_elevated_risk",
		"stripe_high_score",
		"new_account_large_booking",
		"repeat_pairing",
		"collusive_fast_completions",
	]) {
		assert.ok(customer.includes(key), key);
	}
	const provider = fire(PROV);
	for (const key of [
		"shared_payout_destination",
		"payout_velocity",
		"new_provider_fast_payout",
		"far_from_job",
		"fast_completions",
		"payout_ring",
	]) {
		assert.ok(provider.includes(key), key);
	}
});
