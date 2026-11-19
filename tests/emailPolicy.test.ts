// Run with: npx ts-node tests/emailPolicy.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	MailDomainChecker,
	checkRecipient,
	checkRecipientStatic,
	disposableLists,
	lookupMailDomain,
	parseDomainList,
	type DnsResolver,
	type PolicyConfig,
} from "../lib/emailPolicy";
import {
	signupDecision,
	rejectUndeliverableSignup,
	UNDELIVERABLE_SIGNUP_MESSAGE,
} from "../middleware/signupEmailCheck";
import { sendEmail, setEmailDependencies } from "../lib/email";
import { setEventWriter } from "../lib/events";
import { setLogSink } from "../lib/logger";
import { DEMO_ACCOUNT_EMAILS } from "../config/demoAccounts";

setEventWriter(async () => undefined);

const lists = disposableLists();
const config = (overrides: Partial<PolicyConfig> = {}): PolicyConfig => ({
	allowedDomains: new Set(),
	blockedDomains: new Set(),
	demoEmails: DEMO_ACCOUNT_EMAILS,
	disposableExact: lists.exact,
	disposableWildcard: lists.wildcard,
	...overrides,
});

const err = (code: string) => Object.assign(new Error(code), { code });

/** A resolver answering from a table: MX records, A records, or an error code per domain. */
const resolver = (
	table: Record<string, { mx?: string[] | string; a?: string[] | string; aaaa?: string[] | string }>,
): DnsResolver => {
	const answer = (value: string[] | string | undefined) =>
		value === undefined
			? Promise.reject(err("ENOTFOUND"))
			: typeof value === "string"
				? Promise.reject(err(value))
				: Promise.resolve(value);
	return {
		resolveMx: (d) => answer(table[d]?.mx).then((list) => list.map((exchange) => ({ exchange, priority: 10 }))),
		resolve4: (d) => answer(table[d]?.a),
		resolve6: (d) => answer(table[d]?.aaaa),
	};
};

const reason = (email: unknown, cfg = config()) => {
	const decision = checkRecipientStatic(email, cfg);
	return decision.allowed ? "allowed" : decision.reason;
};

test("the disposable list is loaded once into Sets (exact and wildcard)", () => {
	assert.ok(lists.exact.size > 100_000, `exact list has ${lists.exact.size}`);
	assert.ok(lists.wildcard.size > 300, `wildcard list has ${lists.wildcard.size}`);
	assert.equal(disposableLists(), lists, "cached");
});

test("demo accounts are never emailed, whatever the case or spacing, even if their domain is allow-listed", () => {
	assert.equal(reason("user@helphivenow.com"), "demo_account");
	assert.equal(reason("  Provider@HelpHiveNow.com "), "demo_account");
	assert.equal(
		reason("provider@helphivenow.com", config({ allowedDomains: new Set(["helphivenow.com"]) })),
		"demo_account",
	);
});

test("invalid addresses are blocked", () => {
	for (const bad of [
		"",
		"plain",
		"a@",
		"@b.com",
		"a@b",
		"a@@b.com",
		"a b@c.com",
		"a@-b.com",
		"a@b..com",
		"a@b.c",
		`${"x".repeat(65)}@b.com`,
		42,
		null,
		{ $ne: 1 },
	]) {
		assert.equal(reason(bad), "invalid_address", JSON.stringify(bad));
	}
});

test("reserved and test domains are blocked", () => {
	for (const email of [
		"a@example.com",
		"a@EXAMPLE.org",
		"a@mail.example.net",
		"a@shop.test",
		"a@x.example",
		"a@y.invalid",
		"a@box.localhost",
		"a@printer.local",
	]) {
		assert.equal(reason(email), "reserved_domain", email);
	}
	assert.equal(reason("a@example.co.uk"), "allowed", "only the reserved names themselves");
});

test("disposable providers are blocked, including subdomains and wildcard entries", () => {
	assert.equal(reason("someone@mailinator.com"), "disposable_domain");
	assert.equal(reason("someone@inbox.mailinator.com"), "disposable_domain", "parent domain listed");
	const wildcard = [...lists.wildcard][0];
	assert.equal(reason(`someone@anything.${wildcard}`), "disposable_domain", `wildcard ${wildcard}`);
	assert.equal(reason("someone@gmail.com"), "allowed");
});

test("allow-list override wins over the domain rules; the extra block-list adds domains", () => {
	const allow = config({ allowedDomains: parseDomainList(" Mailinator.com , @example.com") });
	assert.equal(reason("qa@mailinator.com", allow), "allowed");
	assert.equal(reason("qa@sub.example.com", allow), "allowed");
	assert.equal(reason("not-an-address", allow), "invalid_address", "syntax still applies");
	const block = config({ blockedDomains: parseDomainList("competitor.io,spam.example.org") });
	assert.equal(reason("x@competitor.io", block), "blocked_domain");
	assert.equal(reason("x@mail.competitor.io", block), "blocked_domain");
	assert.deepEqual([...parseDomainList("")], []);
});

test("plus-addressing and the local part's case are left alone", () => {
	const decision = checkRecipientStatic(" Jane.Doe+helphive@Gmail.COM ", config());
	assert.deepEqual(decision, { allowed: true, domain: "gmail.com", via: "rules", needsDns: true });
});

test("DNS: MX present allows; no domain or no mail server blocks; A record without MX allows; errors and timeouts allow", async () => {
	const dns = resolver({
		"has-mx.com": { mx: ["mx.has-mx.com"] },
		"null-mx.com": { mx: ["."], a: ["192.0.2.1"] },
		"a-only.com": { mx: "ENODATA", a: ["192.0.2.1"], aaaa: "ENODATA" },
		"parked.com": { mx: "ENODATA", a: "ENODATA", aaaa: "ENODATA" },
		"broken.com": { mx: "ESERVFAIL" },
	});
	assert.equal(await lookupMailDomain(dns, "has-mx.com"), "has_mail");
	assert.equal(await lookupMailDomain(dns, "null-mx.com"), "no_mail");
	assert.equal(await lookupMailDomain(dns, "a-only.com"), "has_mail");
	assert.equal(await lookupMailDomain(dns, "parked.com"), "no_mail");
	assert.equal(await lookupMailDomain(dns, "nxdomain.com"), "no_domain");
	assert.equal(await lookupMailDomain(dns, "broken.com"), "error");

	const checker = new MailDomainChecker(dns, 50);
	assert.deepEqual(await checkRecipient("a@has-mx.com", config(), checker), {
		allowed: true,
		domain: "has-mx.com",
		via: "rules",
	});
	assert.deepEqual(await checkRecipient("a@nxdomain.com", config(), checker), {
		allowed: false,
		domain: "nxdomain.com",
		reason: "domain_not_found",
	});
	assert.deepEqual(await checkRecipient("a@parked.com", config(), checker), {
		allowed: false,
		domain: "parked.com",
		reason: "no_mail_server",
	});
	assert.deepEqual(await checkRecipient("a@broken.com", config(), checker), {
		allowed: true,
		domain: "broken.com",
		via: "dns_error",
	});

	const hanging: DnsResolver = {
		resolveMx: () => new Promise(() => undefined),
		resolve4: () => new Promise(() => undefined),
		resolve6: () => new Promise(() => undefined),
	};
	const started = Date.now();
	assert.deepEqual(await checkRecipient("a@slow.com", config(), new MailDomainChecker(hanging, 50)), {
		allowed: true,
		domain: "slow.com",
		via: "dns_error",
	});
	assert.ok(Date.now() - started < 1000, "timeout honoured");

	// Static rules decide first: no DNS lookup for a blocked or allow-listed domain.
	let lookups = 0;
	const counting = { check: async () => (lookups++, "no_domain" as const) };
	await checkRecipient("a@mailinator.com", config(), counting);
	await checkRecipient(
		"a@corp.internal-mail.com",
		config({ allowedDomains: new Set(["internal-mail.com"]) }),
		counting,
	);
	assert.equal(lookups, 0);
});

test("DNS cache: definite answers cached (positive longer than negative), errors not cached", async () => {
	let now = 0;
	let calls = 0;
	let answer: "ok" | "none" | "fail" = "ok";
	const dns: DnsResolver = {
		resolveMx: async () => {
			calls++;
			if (answer === "fail") throw err("ETIMEOUT");
			if (answer === "none") throw err("ENOTFOUND");
			return [{ exchange: "mx", priority: 1 }];
		},
		resolve4: async () => [],
		resolve6: async () => [],
	};
	const checker = new MailDomainChecker(dns, 1000, () => now);
	await checker.check("d.com");
	await checker.check("d.com");
	assert.equal(calls, 1, "positive answer cached");
	now += 6 * 3600 * 1000 + 1;
	answer = "none";
	assert.equal(await checker.check("d.com"), "no_domain");
	now += 59 * 60 * 1000;
	assert.equal(await checker.check("d.com"), "no_domain");
	assert.equal(calls, 2, "negative answer cached for an hour");
	answer = "fail";
	assert.equal(await checker.check("e.com"), "error");
	assert.equal(await checker.check("e.com"), "error");
	assert.equal(calls, 4, "errors are retried, not cached");
});

test("sign-up decision: blocked addresses get 400 with the agreed message; allowed ones continue", async () => {
	assert.deepEqual(signupDecision({ allowed: true, domain: "gmail.com", via: "rules" }), { reject: false });
	assert.deepEqual(signupDecision({ allowed: false, domain: "mailinator.com", reason: "disposable_domain" }), {
		reject: true,
		status: 400,
		body: {
			message: "Use a permanent email address you can receive mail at.",
			errors: [
				{ path: "email", msg: "Use a permanent email address you can receive mail at.", location: "body" },
			],
			field: "email",
			code: "disposable_domain",
		},
		reason: "disposable_domain",
	});

	const middleware = rejectUndeliverableSignup("customer", (email) =>
		checkRecipient(email, config(), { check: async () => "has_mail" as const }),
	);
	const call = async (body: Record<string, unknown>) => {
		const res: any = { statusCode: 200, body: undefined };
		res.status = (code: number) => ((res.statusCode = code), res);
		res.json = (payload: unknown) => ((res.body = payload), res);
		let passed = false;
		await middleware({ body, headers: {} } as any, res, () => (passed = true));
		return { passed, res };
	};
	const blocked = await call({ email: "new@mailinator.com" });
	assert.equal(blocked.passed, false);
	assert.equal(blocked.res.statusCode, 400);
	assert.equal(blocked.res.body.message, UNDELIVERABLE_SIGNUP_MESSAGE);
	assert.equal(blocked.res.body.code, "disposable_domain");
	assert.equal(blocked.res.body.field, "email");
	const ok = await call({ email: "  New.Person@Gmail.com " });
	assert.equal(ok.passed, true);
	assert.equal(ok.res.statusCode, 200);
	assert.equal((await call({ email: "provider@helphivenow.com" })).res.statusCode, 400, "demo address");
});

test("sendEmail skips blocked recipients without calling the provider, and reports provider failures without throwing", async () => {
	const quiet = setLogSink(() => undefined);
	const sent: string[] = [];
	let fail = false;
	setEmailDependencies({
		policy: (email) => checkRecipient(email, config(), { check: async () => "has_mail" as const }),
		client: {
			emails: {
				send: async (input: { to: string[] }) => {
					if (fail) throw new Error("network down");
					sent.push(input.to[0]);
					return { data: { id: "msg_1" }, error: null };
				},
			},
		} as any,
	});
	const base = { template: "refund" as const, from: "Helphive <support@x.com>", subject: "s", react: null as any };
	assert.deepEqual(await sendEmail({ ...base, to: "user@helphivenow.com" }), {
		status: "skipped",
		reason: "demo_account",
	});
	assert.deepEqual(await sendEmail({ ...base, to: "a@example.com" }), {
		status: "skipped",
		reason: "reserved_domain",
	});
	assert.deepEqual(await sendEmail({ ...base, to: "jane.doe@gmail.com" }), { status: "sent", messageId: "msg_1" });
	assert.deepEqual(sent, ["jane.doe@gmail.com"]);
	fail = true;
	assert.deepEqual(await sendEmail({ ...base, to: "jane.doe@gmail.com" }), {
		status: "failed",
		error: "network down",
	});
	setLogSink(quiet);
});
