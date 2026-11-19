// Notifications centre and support cases, the pure rules: segments and their filters, who is never contacted,
// placeholders, push batching, idempotency of sends; case status changes and parties. Pure.
import test from "node:test";
import assert from "node:assert/strict";
import {
	PUSH_BATCH,
	bookedInRangeQuery,
	decideSend,
	emailExclusion,
	parseSegment,
	pushBatches,
	recipientExclusion,
	renderMessage,
	segmentUserFilter,
	sendFingerprint,
	unknownPlaceholders,
	validateTemplate,
	type Recipient,
} from "../lib/notifications";
import { canChangeStatus, caseMessageSubject, caseReference, partiesOf } from "../lib/supportCases";

const id = (n: number) => `6740a1b2c3d4e5f6000000${String(n).padStart(2, "0")}`;

test("segments: each type validates into a canonical form", () => {
	assert.deepEqual(parseSegment({ type: "all_customers", extra: 1 }), {
		ok: true,
		segment: { type: "all_customers" },
	});
	assert.deepEqual(parseSegment({ type: "all_providers" }), {
		ok: true,
		segment: { type: "all_providers", approvedOnly: true },
	});
	assert.deepEqual(parseSegment({ type: "providers_with_service", serviceId: "2", approvedOnly: false }), {
		ok: true,
		segment: { type: "providers_with_service", serviceId: 2, approvedOnly: false },
	});
	assert.equal(parseSegment({ type: "providers_with_service", serviceId: 4 }).ok, false);
	const range = parseSegment({ type: "booked_in_range", from: "2026-11-01", to: "2026-11-30", party: "both" });
	assert.ok(range.ok && range.segment.from === "2026-11-01T00:00:00.000Z" && range.segment.party === "both");
	assert.equal(parseSegment({ type: "booked_in_range", from: "2026-11-30", to: "2026-11-01" }).ok, false);
	assert.equal(
		parseSegment({ type: "booked_in_range", from: "2026-01-01", to: "2026-11-01" }).ok,
		false,
		"at most 92 days",
	);
	assert.equal(parseSegment({ type: "one_person", userId: "nope" }).ok, false);
	assert.equal(parseSegment({ type: "one_person", userId: { $ne: null } }).ok, false);
	assert.equal(parseSegment({ type: "everyone" }).ok, false);
	assert.equal(parseSegment(null).ok, false);
});

test("segment filters always leave suspended accounts out", () => {
	const segments = [
		{ type: "all_customers" },
		{ type: "all_providers", approvedOnly: true },
		{ type: "providers_with_service", serviceId: 1, approvedOnly: false },
		{
			type: "booked_in_range",
			from: "2026-11-01T00:00:00.000Z",
			to: "2026-11-02T00:00:00.000Z",
			party: "customers",
		},
		{ type: "one_person", userId: id(1) },
	] as const;
	for (const s of segments) assert.deepEqual(segmentUserFilter(s as any, [id(2)]).suspended, { $ne: true }, s.type);
	assert.deepEqual(segmentUserFilter({ type: "all_customers" }), {
		suspended: { $ne: true },
		"roles.Provider": { $ne: true },
	});
	assert.deepEqual(segmentUserFilter({ type: "all_providers", approvedOnly: true }), {
		suspended: { $ne: true },
		"roles.Provider": true,
		providerStatus: "approved",
	});
	assert.equal(segmentUserFilter({ type: "providers_with_service", serviceId: 3 })["selectedJobTypes.id"], 3);
	assert.equal("providerStatus" in segmentUserFilter({ type: "all_providers", approvedOnly: false }), false);
	assert.deepEqual(segmentUserFilter({ type: "booked_in_range" } as any, [id(2)])._id, { $in: [id(2)] });
	assert.deepEqual(segmentUserFilter({ type: "booked_in_range" } as any)._id, { $in: [] }, "nobody booked: nobody");
});

test("booked in range: which side of the bookings is the audience", () => {
	const base = { type: "booked_in_range" as const, from: "2026-11-01T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" };
	assert.deepEqual(bookedInRangeQuery({ ...base, party: "customers" }).fields, ["userId"]);
	assert.deepEqual(bookedInRangeQuery({ ...base, party: "providers" }).fields, ["providerId"]);
	assert.deepEqual(bookedInRangeQuery({ ...base, party: "both" }).fields, ["userId", "providerId"]);
	assert.deepEqual(bookedInRangeQuery({ ...base, party: "both" }).filter.startDate.$gte, new Date(base.from));
});

const person = (over: Partial<Recipient> = {}): Recipient => ({
	_id: id(1),
	email: "amira@gmail.com",
	firstName: "Amira",
	lastName: "Haddad",
	isProvider: false,
	suspended: false,
	isEmailVerified: true,
	...over,
});

test("never contacted: suspended accounts and the shared demo accounts; email only to verified addresses", () => {
	assert.equal(recipientExclusion(person()), null);
	assert.equal(recipientExclusion(person({ suspended: true })), "suspended");
	assert.equal(recipientExclusion(person({ email: "User@HelpHiveNow.com" })), "demo_account");
	assert.equal(recipientExclusion(person({ email: "provider@helphivenow.com" })), "demo_account");
	assert.equal(emailExclusion(person({ isEmailVerified: false })), "email_not_verified");
	assert.equal(emailExclusion(person({ suspended: true, isEmailVerified: false })), "suspended");
	assert.equal(emailExclusion(person()), null);
});

test("templates: a small set of placeholders, rendered per person; unknown ones are refused", () => {
	assert.deepEqual(unknownPlaceholders("Hi {{firstName}}, {{ coupon }} and {{role}}"), ["coupon"]);
	assert.equal(validateTemplate({ title: "Hi {{firstName}}", body: "Use {{coupon}}" }, ["push"]).ok, false);
	assert.equal(validateTemplate({ title: "", body: "x" }, ["push"]).ok, false);
	assert.equal(validateTemplate({ title: "x".repeat(66), body: "x" }, ["push"]).ok, false);
	assert.equal(validateTemplate({ title: "x", body: "y" }, []).ok, false);
	const t = validateTemplate(
		{
			title: " Hello {{firstName}} ",
			body: "As a {{role}}, write to {{supportEmail}}. Bye {{ lastName }}.",
			emailSubject: "",
		},
		["push", "email"],
	);
	assert.ok(t.ok);
	const rendered = renderMessage(t.ok ? t.template : (null as any), person({ isProvider: true }), "support@x.com");
	assert.deepEqual(rendered, {
		title: "Hello Amira",
		body: "As a provider, write to support@x.com. Bye Haddad.",
		emailSubject: "Hello Amira",
	});
	assert.equal(
		renderMessage({ title: "Hi {{firstName}}", body: "b" }, person({ firstName: " " }), "s").title,
		"Hi there",
	);
});

test("push batching: one request per rendered text, at most 2000 people each", () => {
	const people = Array.from({ length: 4500 }, (_, i) => person({ _id: `u${i}`, firstName: i % 2 ? "Sam" : "Ali" }));
	const plain = pushBatches({ title: "News", body: "Hello" }, people, "s");
	assert.deepEqual(
		plain.map((b) => b.ids.length),
		[PUSH_BATCH, PUSH_BATCH, 500],
	);
	const personal = pushBatches({ title: "Hi {{firstName}}", body: "x" }, people, "s");
	assert.equal(personal.length, 4, "two names, 2250 each, two batches per name");
	assert.equal(new Set(personal.flatMap((b) => b.ids)).size, 4500, "everyone exactly once");
	assert.ok(personal.every((b) => b.ids.length <= PUSH_BATCH));
});

test("idempotency: a repeated key replays, a send in flight is refused, a reused key with a different request is refused", () => {
	const request = {
		segment: { type: "all_customers" as const },
		channels: ["push", "email"] as ("push" | "email")[],
		template: { title: "a", body: "b" },
	};
	const fp = sendFingerprint(request);
	assert.equal(fp, sendFingerprint({ ...request, channels: ["email", "push"] }), "channel order does not matter");
	assert.equal(fp, sendFingerprint({ ...request, template: { title: "a", body: "b", emailSubject: null } }));
	assert.notEqual(fp, sendFingerprint({ ...request, template: { title: "a", body: "c" } }));
	assert.equal(decideSend(null, fp), "new");
	assert.equal(decideSend({ fingerprint: fp, status: "sent" }, fp), "replay");
	assert.equal(decideSend({ fingerprint: fp, status: "partial" }, fp), "replay");
	assert.equal(decideSend({ fingerprint: fp, status: "failed" }, fp), "replay");
	assert.equal(decideSend({ fingerprint: fp, status: "sending" }, fp), "in_progress");
	assert.equal(decideSend({ fingerprint: "other", status: "sent" }, fp), "key_reused");
});

test("support cases: status changes, references, parties and message subjects", () => {
	assert.deepEqual(canChangeStatus("open", "waiting_on_customer"), { ok: true });
	assert.equal(canChangeStatus("open", "open").ok, false);
	assert.equal(canChangeStatus("open", "resolved").ok, false, "resolve needs an outcome");
	assert.equal(canChangeStatus("open", "closed").ok, false, "resolve first");
	assert.deepEqual(canChangeStatus("resolved", "closed"), { ok: true });
	assert.deepEqual(canChangeStatus("resolved", "open"), { ok: true });
	assert.equal(canChangeStatus("closed", "waiting_on_provider").ok, false);
	assert.deepEqual(canChangeStatus("closed", "open"), { ok: true });
	assert.equal(caseReference("6740a1b2c3d4e5f601abcdef"), "CS-ABCDEF");
	assert.deepEqual(partiesOf({ booking: { userId: id(1), providerId: id(2) } }), [
		{ role: "customer", userId: id(1) },
		{ role: "provider", userId: id(2) },
	]);
	assert.deepEqual(
		partiesOf({ booking: { userId: id(1), providerId: null }, user: { _id: id(1), roles: { Provider: false } } }),
		[{ role: "customer", userId: id(1) }],
	);
	assert.deepEqual(partiesOf({ user: { _id: id(3), roles: { Provider: true } } }), [
		{ role: "provider", userId: id(3) },
	]);
	assert.equal(caseMessageSubject("CS-ABCDEF", "Your refund"), "Your refund [CS-ABCDEF]");
	assert.equal(caseMessageSubject("CS-ABCDEF", "Re: CS-ABCDEF"), "Re: CS-ABCDEF");
});
