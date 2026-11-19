// Block and allow list matching, payout hold checks, Stripe assessment mapping, the linked-accounts graph and the
// backtest. Pure.
import test from "node:test";
import assert from "node:assert/strict";
import {
	decideLists,
	formatIp,
	indexEntries,
	ipInRange,
	normalizeDomain,
	normalizeEmail,
	normalizeIp,
	normalizeListValue,
	normalizePhone,
	parseIp,
	parseRange,
	type ListEntry,
} from "../lib/risk/lists";
import {
	blocksEarningRelease,
	blocksPayout,
	holdStateFrom,
	payoutReservationFilter,
	PAYOUT_HELD,
} from "../lib/risk/holds";
import { assessmentFromCharge } from "../lib/risk/stripeRisk";
import { buildLinkGraph, clampLimits, linksFromIndex, type Link } from "../lib/risk/graph";
import { runBacktest, peopleOf } from "../lib/risk/backtest";
import { indexDataset } from "../lib/risk/signals";
import { BLOCKED_BODY, blockedStatus } from "../lib/risk/gate";
import { fixture, NOW } from "./riskFixture";

test("emails: case, plus addresses, Gmail dots and googlemail.com", () => {
	assert.equal(normalizeEmail("  Jane.Doe+promo@GoogleMail.com "), "janedoe@gmail.com");
	assert.equal(normalizeEmail("j.doe+x@Example.co.uk"), "j.doe@example.co.uk");
	assert.equal(normalizeEmail("+x@example.com"), "+x@example.com");
	assert.equal(normalizeEmail("nobody"), null);
	assert.equal(normalizeEmail("a@localhost"), null);
	assert.equal(normalizeDomain("@Mailinator.COM."), "mailinator.com");
	assert.equal(normalizeDomain("not a domain"), null);
});

test("IP addresses: v4, v6, mapped v4, ranges with host bits cleared, minimum prefixes", () => {
	assert.equal(normalizeIp("203.0.113.009"), "203.0.113.9");
	assert.equal(normalizeIp("::ffff:203.0.113.9"), "203.0.113.9");
	assert.equal(normalizeIp("2001:DB8::1"), "2001:db8:0:0:0:0:0:1");
	assert.equal(normalizeIp("256.1.1.1"), null);
	assert.equal(normalizeIp("1.2.3"), null);
	assert.equal(formatIp(parseIp("::1")!), "0:0:0:0:0:0:0:1");
	const range = parseRange("10.1.2.3/8")!;
	assert.equal(range.prefix, 8);
	assert.ok(ipInRange(parseIp("10.200.0.1")!, range));
	assert.ok(!ipInRange(parseIp("11.0.0.1")!, range));
	assert.ok(!ipInRange(parseIp("2001:db8::1")!, range), "versions never match each other");
	assert.ok(ipInRange(parseIp("2001:db8:ffff::1")!, parseRange("2001:db8::/32")!));
	assert.equal(normalizeListValue("ip_range", "10.1.2.3/8"), "10.0.0.0/8");
	assert.equal(normalizeListValue("ip_range", "10.0.0.0/7"), null, "wider than /8 is refused");
	assert.equal(normalizeListValue("ip_range", "2001:db8::/16"), null);
	assert.equal(normalizeListValue("ip_range", "10.0.0.0"), null);
	assert.equal(normalizeListValue("ip_range", "10.0.0.0/33"), null);
});

test("phones: compared on the last nine digits", () => {
	assert.equal(normalizePhone("07911 123456"), normalizePhone("+44 (0)7911-123456"));
	assert.equal(normalizePhone("12345"), null);
});

const entry = (
	n: number,
	list: "block" | "allow",
	kind: ListEntry["kind"],
	raw: string,
	extra: Partial<ListEntry> = {},
): ListEntry => ({
	id: String(n),
	list,
	kind,
	value: normalizeListValue(kind, raw)!,
	...extra,
});

test("list matching: every kind, domain parents, ranges, expiry, removal, allow wins", () => {
	const entries = [
		entry(1, "block", "email", "Bad.Guy+1@gmail.com"),
		entry(2, "block", "email_domain", "spam.example"),
		entry(3, "block", "device", "DEVICE-1234"),
		entry(4, "block", "ip_range", "198.51.100.0/24"),
		entry(5, "block", "phone", "+44 7700 900461"),
		entry(6, "block", "ip", "192.0.2.7", { expiresAt: NOW - 1 }),
		entry(7, "block", "ip", "192.0.2.8", { removedAt: NOW - 1 }),
		entry(8, "allow", "email", "vip@hotel.example"),
	];
	const index = indexEntries(entries, NOW);
	const decide = (subject: Parameters<typeof decideLists>[1]) => decideLists(index, subject);
	assert.equal(decide({ email: "badguy@googlemail.com" }).blocked, true);
	assert.equal(decide({ email: "x@mail.spam.example" }).block[0].entry.id, "2");
	assert.equal(decide({ deviceId: "device-1234" }).blocked, true);
	assert.equal(decide({ ip: "198.51.100.77" }).block[0].field, "ip");
	assert.equal(decide({ ip: "::ffff:198.51.100.77" }).blocked, true);
	assert.equal(decide({ phone: "07700 900461" }).blocked, true);
	assert.equal(decide({ ip: "192.0.2.7" }).blocked, false, "expired");
	assert.equal(decide({ ip: "192.0.2.8" }).blocked, false, "removed");
	assert.equal(decide({ email: "fine@hotel.example", ip: "203.0.113.1" }).blocked, false);
	const allowed = decide({ email: "VIP@hotel.example", ip: "198.51.100.1" });
	assert.equal(allowed.blocked, false, "an allow entry lets a known person through a blocked range");
	assert.equal(allowed.block.length, 1);
	assert.equal(allowed.allow.length, 1);
});

test("the blocked answer is generic, 423 at sign-in and 403 elsewhere", () => {
	assert.equal(blockedStatus("signin"), 423);
	assert.equal(blockedStatus("signup"), 403);
	assert.equal(blockedStatus("booking"), 403);
	assert.ok(!/list|block|device|address/i.test(BLOCKED_BODY.message));
});

test("payout holds: the flag from the active holds, what each state stops, the atomic reservation filter", () => {
	assert.equal(holdStateFrom([]), null);
	assert.equal(holdStateFrom([{ kind: "review_before_payout" }]), "review");
	assert.equal(holdStateFrom([{ kind: "review_before_payout" }, { kind: "hold" }]), "hold");
	assert.equal(blocksPayout("hold"), true);
	assert.equal(blocksPayout("review"), true);
	assert.equal(blocksPayout(null), false);
	assert.equal(blocksPayout(undefined), false);
	assert.equal(blocksEarningRelease("review"), false);
	assert.equal(blocksEarningRelease("hold"), true);
	// Missing or null flag only: a hold placed between the read and the update makes the update match nothing.
	assert.deepEqual(payoutReservationFilter("u1", 50), {
		_id: "u1",
		availableBalance: { $gte: 50 },
		payoutHold: { $in: [null] },
	});
	assert.equal(PAYOUT_HELD.body.code, "payouts_on_hold");
});

test("Stripe assessment: outcome and card fields, missing ones as null", () => {
	const assessed = assessmentFromCharge({
		outcome: {
			type: "authorized",
			risk_level: "elevated",
			risk_score: 66,
			network_status: "approved_by_network",
			reason: null,
			seller_message: "ok",
		} as any,
		payment_method_details: {
			card: { fingerprint: "fp", brand: "visa", last4: "4242", country: "GB", funding: "credit" },
		} as any,
	});
	assert.deepEqual(assessed.outcome, {
		type: "authorized",
		riskLevel: "elevated",
		riskScore: 66,
		networkStatus: "approved_by_network",
		reason: null,
		sellerMessage: "ok",
	});
	assert.equal(assessed.card.fingerprint, "fp");
	const empty = assessmentFromCharge({});
	assert.equal(empty.outcome.riskLevel, null);
	assert.equal(empty.card.fingerprint, null);
});

// --- Graph -------------------------------------------------------------------------------------------------------

const chain =
	(links: Record<string, [string, Link["kind"]][]>) =>
	(id: string): Link[] =>
		(links[id] ?? []).map(([to, kind]) => ({ from: id, to, kind, count: 1 }));

test("graph: links from the fixture dataset with reasons", () => {
	const index = indexDataset(fixture());
	const cust = "000000000000000000000001";
	const links = linksFromIndex(index, cust, NOW);
	const kinds = (to: string) =>
		links
			.filter((l) => l.to === to)
			.map((l) => l.kind)
			.sort();
	assert.deepEqual(kinds("000000000000000000000002"), ["device", "phone"]);
	assert.deepEqual(kinds("000000000000000000000003"), ["pairing"]);
	assert.deepEqual(kinds("000000000000000000000004"), ["device", "ip"]);
	assert.deepEqual(kinds("000000000000000000000005"), ["booking_address"]);
	assert.ok(!links.some((l) => l.to === cust), "never a link to oneself");
	const prov = linksFromIndex(index, "000000000000000000000003", NOW);
	assert.ok(prov.some((l) => l.to === "000000000000000000000004" && l.kind === "payout_destination"));
});

test("graph: depth limit, node limit, links per node strongest first, merged edges", async () => {
	const getLinks = chain({
		a: [
			["b", "device"],
			["c", "ip"],
			["d", "payout_destination"],
		],
		b: [
			["a", "device"],
			["e", "phone"],
		],
		d: [["f", "pairing"]],
		e: [["g", "device"]],
	});
	const deep = await buildLinkGraph("a", getLinks, { depth: 2, maxNodes: 50, maxLinksPerNode: 10 });
	assert.deepEqual(deep.nodes.map((n) => `${n.id}${n.depth}`).sort(), ["a0", "b1", "c1", "d1", "e2", "f2"]);
	assert.equal(deep.truncated, false);
	assert.equal(deep.edges.filter((e) => e.source === "a" && e.target === "b").length, 1, "a-b merged");
	const small = await buildLinkGraph("a", getLinks, { depth: 3, maxNodes: 3, maxLinksPerNode: 10 });
	assert.equal(small.nodes.length, 3);
	assert.equal(small.truncated, true);
	const narrow = await buildLinkGraph("a", getLinks, { depth: 1, maxNodes: 50, maxLinksPerNode: 1 });
	assert.deepEqual(
		narrow.nodes.map((n) => n.id),
		["a", "d"],
		"the payout link is the strongest",
	);
	assert.equal(narrow.truncated, true);
	assert.deepEqual(clampLimits({ depth: 9, maxNodes: 1, maxLinksPerNode: NaN }), {
		depth: 3,
		maxNodes: 2,
		maxLinksPerNode: 15,
	});
});

// --- Backtest ----------------------------------------------------------------------------------------------------

const backtestRule = {
	key: "draft",
	title: "Draft",
	explanation: "",
	match: "all" as const,
	conditions: [{ signal: "bookings_created_24h", op: "gte" as const, value: 5 }],
	weight: 10,
	severity: "medium" as const,
	actions: ["score", "open_case", "hold_payouts"] as ("score" | "open_case" | "hold_payouts")[],
	mode: "observe" as const,
};

test("backtest: hits once per person per day, actions per person, providers only for holds", () => {
	const result = runBacktest(indexDataset(fixture()), backtestRule, { from: NOW - 3 * 86400000, to: NOW });
	assert.equal(result.people, 1);
	assert.equal(result.hits, 1);
	assert.equal(result.subjects[0].userId, "000000000000000000000001");
	assert.deepEqual(result.subjects[0].actions, ["open_case"], "a customer cannot get a payout hold");
	assert.deepEqual(result.actions, { open_case: 1 });
	assert.equal(result.byDay.length, 4);
	assert.equal(
		result.byDay.reduce((s, d) => s + d.hits, 0),
		1,
	);
});

test("backtest: deterministic, whatever order the records were loaded in", () => {
	const ds = fixture();
	const first = runBacktest(indexDataset(ds), backtestRule, { from: NOW - 30 * 86400000, to: NOW });
	const shuffled = {
		...ds,
		events: [...ds.events].reverse(),
		bookings: [...ds.bookings].reverse(),
		payouts: [...ds.payouts].reverse(),
	};
	const second = runBacktest(indexDataset(shuffled), backtestRule, { from: NOW - 30 * 86400000, to: NOW });
	assert.deepEqual(second, first);
	assert.deepEqual(runBacktest(indexDataset(ds), backtestRule, { from: NOW - 30 * 86400000, to: NOW }), first);
});

test("who an event is about: the actor, customer and provider, the customer through the booking", () => {
	assert.deepEqual(
		peopleOf({
			id: "1",
			type: "booking.accepted",
			at: 0,
			actorType: "provider",
			actorId: "p",
			userId: "c",
			providerId: "p",
			properties: {},
		}),
		["c", "p"],
	);
	assert.deepEqual(
		peopleOf(
			{ id: "2", type: "payment.failed", at: 0, actorType: "system", bookingId: "b", properties: {} },
			() => "c",
		),
		["c"],
	);
});
