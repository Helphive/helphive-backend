import test from "node:test";
import assert from "node:assert/strict";
import {
	SIGNUP_EMAIL_MESSAGES,
	TYPO_DOMAINS,
	assessSignupEmail,
	canonicalEmail,
	normaliseEmail,
} from "../lib/emailAddress";
import { checkRecipientStatic, disposableLists, type PolicyConfig } from "../lib/emailPolicy";
import { checkNewAccountEmail } from "../middleware/signupEmailCheck";
import { emailTakenBody, isDuplicateKeyError } from "../controllers/user-controllers/utils/accountEmail.utils";
import { DEMO_ACCOUNT_EMAILS } from "../config/demoAccounts";

const code = (email: unknown) => {
	const result = assessSignupEmail(email);
	return result.ok ? "ok" : result.code;
};

test("normaliseEmail trims and lower-cases", () => {
	assert.equal(normaliseEmail("  Name@Gmail.COM "), "name@gmail.com");
	assert.equal(normaliseEmail(42), "");
});

test("canonicalEmail: case and +tag everywhere; dots and googlemail only for Gmail", () => {
	assert.equal(canonicalEmail("A.B+x@GoogleMail.com"), canonicalEmail("ab@gmail.com"));
	assert.equal(canonicalEmail("A.B+x@GoogleMail.com"), "ab@gmail.com");
	assert.equal(canonicalEmail("Name@Outlook.com"), canonicalEmail("name@outlook.com"));
	assert.equal(canonicalEmail("Name@gmail.com"), canonicalEmail("name@gmail.com"));
	assert.equal(canonicalEmail("first.last+hh@outlook.com"), "first.last@outlook.com", "dots kept outside Gmail");
	assert.notEqual(canonicalEmail("first.last@outlook.com"), canonicalEmail("firstlast@outlook.com"));
});

test("sign-up refuses bad syntax and over-long addresses", () => {
	for (const bad of ["", "plain", "a@", "@b.com", "a@b", "a b@c.com", "a@b..com", null, 7, { $ne: 1 }]) {
		assert.equal(code(bad), "invalid_address", JSON.stringify(bad));
	}
	for (const bad of [".abcdef@gmail.com", "abcdef.@gmail.com", "abc..def@gmail.com"]) {
		assert.equal(code(bad), "invalid_address", bad);
	}
	const long = `${"a".repeat(60)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(20)}.com`;
	assert.ok(long.length > 254);
	assert.equal(code(long), "invalid_address");
});

test("sign-up refuses a +tag with the agreed message", () => {
	for (const email of ["someone+user2@gmail.com", "someone+provider1@gmail.com", "info+x@some-hotel.com"]) {
		const result = assessSignupEmail(email);
		assert.equal(result.ok, false, email);
		if (!result.ok) {
			assert.equal(result.code, "plus_tag");
			assert.equal(
				result.message,
				"Email addresses with a + tag can't be used to sign up. Use the address without it.",
			);
		}
	}
});

test("sign-up refuses typo domains and suggests the corrected address", () => {
	const required = [
		"gmai.com",
		"gmial.com",
		"gmal.com",
		"gamil.com",
		"gnail.com",
		"gmaill.com",
		"gmail.co",
		"gmail.con",
		"gmail.cm",
		"hotmial.com",
		"hotmal.com",
		"hotmai.com",
		"hotmail.con",
		"outlok.com",
		"outloo.com",
		"outlook.con",
		"yaho.com",
		"yahooo.com",
		"yahoo.con",
		"iclod.com",
		"icloud.con",
		"protonmai.com",
	];
	for (const domain of required) assert.ok(TYPO_DOMAINS[domain], domain);
	const result = assessSignupEmail("Maria.Garcia@Gmai.com");
	assert.deepEqual(result, {
		ok: false,
		code: "typo_domain",
		message: "Did you mean maria.garcia@gmail.com?",
		suggestion: "maria.garcia@gmail.com",
	});
	assert.equal(code("p@gmai.com"), "typo_domain");
	const hot = assessSignupEmail("someone@hotmial.com");
	assert.equal(!hot.ok && hot.suggestion, "someone@hotmail.com");
});

test("sign-up refuses impossible Gmail addresses", () => {
	for (const email of [
		"jh@gmail.com",
		"test@gmail.com",
		"trump@gmail.com",
		"p7@gmail.com",
		"u2@gmail.com",
		"abc@gmail.com",
		"user1@gmail.com",
		"abc_def1@gmail.com",
		`${"a".repeat(31)}@gmail.com`,
		"a.b.c.d.e@googlemail.com",
	]) {
		const result = assessSignupEmail(email);
		assert.equal(result.ok, false, email);
		if (!result.ok) {
			assert.equal(result.code, "impossible_gmail", email);
			assert.equal(result.message, "That doesn't look like a real Gmail address. Check it and try again.");
		}
	}
});

test("sign-up refuses placeholders on free providers only", () => {
	for (const email of [
		"provider@gmail.com",
		"provider1@gmail.com",
		"customer@gmail.com",
		"testing@gmail.com",
		"user12@yahoo.com",
		"test@outlook.com",
		"admin@hotmail.co.uk",
		"demo@icloud.com",
		"name@proton.me",
		"qwerty@gmx.de",
		"noemail@zoho.com",
	]) {
		assert.equal(code(email), "placeholder_address", email);
	}
	assert.equal(code("admin@some-hotel.com"), "ok");
	assert.equal(code("info@some-hotel.com"), "ok");
	assert.equal(code("test@grandhotel.co.uk"), "ok", "a business domain may use any name");
	assert.equal(code("testerman@gmail.com"), "ok", "only the whole local part is a placeholder");
});

test("sign-up refuses reserved and disposable domains (shared lists)", () => {
	assert.equal(code("admin@grandhotel.example.org"), "reserved_domain");
	assert.equal(code("someone@shop.test"), "reserved_domain");
	assert.equal(code("someone@mailinator.com"), "disposable_domain");
	assert.equal(code("x@betzenn.com"), "disposable_domain");
	assert.equal(assessSignupEmail("someone@mailinator.com", { allowedDomains: new Set(["mailinator.com"]) }).ok, true);
	const result = assessSignupEmail("x@betzenn.com");
	assert.equal(!result.ok && result.message, SIGNUP_EMAIL_MESSAGES.undeliverable);
});

test("legitimate addresses pass and come back normalised with their canonical form", () => {
	for (const email of [
		"first.last@gmail.com",
		"maria.garcia82@yahoo.com",
		"admin@grandhotel.co.uk",
		"info@some-hotel.com",
		"sp22-bcs-039@cuilahore.edu.pk",
		"abcdef@gmail.com",
		"a.bcdef@googlemail.com",
	]) {
		assert.equal(code(email), "ok", email);
	}
	assert.deepEqual(assessSignupEmail("  First.Last@Gmail.com "), {
		ok: true,
		email: "first.last@gmail.com",
		canonical: "firstlast@gmail.com",
	});
});

test("every example account from the clean-up is refused at sign-up", () => {
	for (const email of [
		"p@gmai.com",
		"jh@gmail.com",
		"test@gmail.com",
		"trump@gmail.com",
		"p7@gmail.com",
		"u2@gmail.com",
		"abc@gmail.com",
		"user1@gmail.com",
		"provider@gmail.com",
		"someone+user2@gmail.com",
		"someone+provider1@gmail.com",
		"x@betzenn.com",
	]) {
		assert.notEqual(code(email), "ok", email);
	}
	assert.equal(canonicalEmail("Name@gmail.com"), canonicalEmail("name@gmail.com"), "case duplicates collide");
});

const lists = disposableLists();
const config: PolicyConfig = {
	allowedDomains: new Set(),
	blockedDomains: new Set(),
	demoEmails: DEMO_ACCOUNT_EMAILS,
	disposableExact: lists.exact,
	disposableWildcard: lists.wildcard,
};
const sendReason = (email: string) => {
	const decision = checkRecipientStatic(email, config);
	return decision.allowed ? "allowed" : decision.reason;
};

test("send-time policy also refuses typo, impossible Gmail and placeholder addresses, but allows a +tag", () => {
	assert.equal(sendReason("someone@gmai.com"), "typo_domain");
	assert.equal(sendReason("jh@gmail.com"), "impossible_gmail");
	assert.equal(sendReason("provider1@gmail.com"), "placeholder_address");
	assert.equal(sendReason("user12@yahoo.com"), "placeholder_address");
	assert.equal(sendReason("x@betzenn.com"), "disposable_domain");
	assert.equal(sendReason("someone.real+user2@gmail.com"), "allowed", "+tag allowed when sending");
	assert.equal(sendReason("Jane.Doe@Gmail.com"), "allowed");
	assert.equal(sendReason("admin@some-hotel.com"), "allowed");
	assert.equal(sendReason("not-an-address"), "invalid_address");
});

test("checkNewAccountEmail: address rules first (no DNS), then the policy; DNS errors fail open", async () => {
	let lookups = 0;
	const policy = (decision: "allow" | "no_mail" | "throw") => async (email: unknown) => {
		lookups++;
		if (decision === "throw") throw new Error("dns down");
		return decision === "allow"
			? ({ allowed: true, domain: String(email).split("@")[1], via: "rules" } as const)
			: ({ allowed: false, domain: String(email).split("@")[1], reason: "no_mail_server" } as const);
	};
	const typo = await checkNewAccountEmail("maria@gmial.com", policy("allow"));
	assert.equal(typo.ok, false);
	if (!typo.ok) {
		assert.deepEqual(typo.body, {
			message: "Did you mean maria@gmail.com?",
			errors: [{ path: "email", msg: "Did you mean maria@gmail.com?", location: "body" }],
			field: "email",
			code: "typo_domain",
			suggestion: "maria@gmail.com",
		});
	}
	assert.equal(lookups, 0, "no DNS for an address the rules refuse");

	const noMx = await checkNewAccountEmail("someone@parked-hotel.com", policy("no_mail"));
	assert.equal(noMx.ok, false);
	if (!noMx.ok) assert.equal(noMx.body.code, "no_mail_server");

	assert.deepEqual(await checkNewAccountEmail(" Info@Some-Hotel.com ", policy("throw")), {
		ok: true,
		email: "info@some-hotel.com",
	});
});

test("duplicate guard helpers: the taken message is the one sign-up always gave; E11000 is a duplicate", () => {
	assert.deepEqual(emailTakenBody({ roles: { Provider: true } }), {
		message: "A provider account already exists on this email. Please use a different one.",
	});
	assert.deepEqual(emailTakenBody({ roles: { Provider: false } }), {
		message: "An account already exists on this email. Please use a different one.",
	});
	assert.deepEqual(emailTakenBody(null), {
		message: "An account already exists on this email. Please use a different one.",
	});
	assert.equal(isDuplicateKeyError({ code: 11000 }), true);
	assert.equal(isDuplicateKeyError(new Error("x")), false);
});
