// Email address rules shared by sign-up (assessSignupEmail) and the outbound recipient policy (lib/emailPolicy.ts).
// Pure: no network and no database. The disposable-domain list is the disposable-email-domains package, loaded once.

// --- Data. To extend a list, add lower-case entries here; both sign-up and the send-time policy pick them up. ---------

/** Misspelt domains of the big providers, mapped to the domain the person almost certainly meant. */
export const TYPO_DOMAINS: Readonly<Record<string, string>> = {
	"gmai.com": "gmail.com",
	"gmial.com": "gmail.com",
	"gmal.com": "gmail.com",
	"gamil.com": "gmail.com",
	"gnail.com": "gmail.com",
	"gmaill.com": "gmail.com",
	"gmail.co": "gmail.com",
	"gmail.con": "gmail.com",
	"gmail.cm": "gmail.com",
	"hotmial.com": "hotmail.com",
	"hotmal.com": "hotmail.com",
	"hotmai.com": "hotmail.com",
	"hotmail.con": "hotmail.com",
	"outlok.com": "outlook.com",
	"outloo.com": "outlook.com",
	"outlook.con": "outlook.com",
	"yaho.com": "yahoo.com",
	"yahooo.com": "yahoo.com",
	"yahoo.con": "yahoo.com",
	"iclod.com": "icloud.com",
	"icloud.con": "icloud.com",
	"protonmai.com": "proton.me",
};

/** Free mail providers, where a placeholder local part (test@, user1@) is never a real customer. Exact domains. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
	"gmail.com",
	"googlemail.com",
	"msn.com",
	"icloud.com",
	"me.com",
	"aol.com",
	"proton.me",
	"protonmail.com",
	"mail.com",
	"zoho.com",
]);
/** Free mail brands under any country domain (yahoo.co.uk, hotmail.fr, gmx.de). */
export const FREE_MAIL_BRANDS: ReadonlySet<string> = new Set(["yahoo", "ymail", "outlook", "hotmail", "live", "gmx"]);

/** Local parts that are placeholders on free providers, each optionally followed by digits (user12, provider1). */
export const PLACEHOLDER_LOCAL_PARTS: readonly string[] = [
	"test",
	"testing",
	"tester",
	"user",
	"customer",
	"provider",
	"admin",
	"example",
	"sample",
	"demo",
	"fake",
	"abc",
	"abcd",
	"asdf",
	"qwerty",
	"foo",
	"bar",
	"none",
	"null",
	"noemail",
	"nomail",
	"email",
	"mail",
	"name",
];

/** Throwaway domains seen in sign-ups that the disposable-email-domains package does not list yet. */
export const EXTRA_DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(["betzenn.com"]);

export const RESERVED_EXACT: ReadonlySet<string> = new Set(["example.com", "example.net", "example.org"]);
export const RESERVED_SUFFIXES: readonly string[] = ["test", "example", "invalid", "localhost", "local"];

// --- Messages ---------------------------------------------------------------------------------------------------

export const SIGNUP_EMAIL_MESSAGES = {
	invalid_address: "Enter a valid email address.",
	plus_tag: "Email addresses with a + tag can't be used to sign up. Use the address without it.",
	impossible_gmail: "That doesn't look like a real Gmail address. Check it and try again.",
	placeholder_address: "Use your own email address, not a placeholder like test@ or user@.",
	undeliverable: "Use a permanent email address you can receive mail at.",
} as const;

// --- Syntax and normalisation --------------------------------------------------------------------------------------

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const PLACEHOLDER = new RegExp(`^(?:${PLACEHOLDER_LOCAL_PARTS.join("|")})\\d*$`);
const BRAND_SUFFIX = /^(?:(?:co|com|net|org)\.)?[a-z]{2,3}$/;

/** Trimmed and lower-cased; "" for anything that is not a string. */
export const normaliseEmail = (input: unknown): string => (typeof input === "string" ? input.trim().toLowerCase() : "");

const split = (email: string) => {
	const at = email.lastIndexOf("@");
	return at <= 0 ? null : { local: email.slice(0, at), domain: email.slice(at + 1) };
};

/**
 * The mailbox identity used to find duplicate accounts: lower-cased, the +tag removed, and for Gmail the dots removed
 * and googlemail.com mapped to gmail.com. `A.B+x@GoogleMail.com` and `ab@gmail.com` are the same mailbox.
 */
export const canonicalEmail = (input: unknown): string => {
	const email = normaliseEmail(input);
	const parts = split(email);
	if (!parts) return email;
	let local = parts.local.split("+")[0];
	let domain = parts.domain.replace(/\.$/, "");
	if (GMAIL_DOMAINS.has(domain)) {
		local = local.replace(/\./g, "");
		domain = "gmail.com";
	}
	return `${local}@${domain}`;
};

/** Trimmed address with a lower-case domain; the local part keeps its case (and any +tag). */
export const normalizeAddress = (email: unknown): { address: string; local: string; domain: string } | null => {
	if (typeof email !== "string") return null;
	const trimmed = email.trim();
	const at = trimmed.lastIndexOf("@");
	if (at <= 0 || at === trimmed.length - 1) return null;
	const local = trimmed.slice(0, at);
	const domain = trimmed
		.slice(at + 1)
		.toLowerCase()
		.replace(/\.$/, "");
	return { address: `${local}@${domain}`, local, domain };
};

export const isValidAddress = (local: string, domain: string) => {
	if (local.length > 64 || local.length + domain.length + 1 > 254) return false;
	if (!LOCAL_PART.test(local)) return false;
	const labels = domain.split(".");
	if (labels.length < 2 || domain.length > 253) return false;
	if (!labels.every((label) => LABEL.test(label))) return false;
	return /^[a-z]{2,63}$/.test(labels[labels.length - 1]) || /^xn--[a-z0-9-]+$/.test(labels[labels.length - 1]);
};

// --- Domains ------------------------------------------------------------------------------------------------------

/** The domain and each parent with at least two labels: a.b.example.com -> [a.b.example.com, b.example.com, example.com]. */
export const domainAndParents = (domain: string) => {
	const labels = domain.split(".");
	const out: string[] = [];
	for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
	return out;
};

export const listedDomain = (set: ReadonlySet<string>, domain: string) =>
	domainAndParents(domain).some((d) => set.has(d));

export const isReservedDomain = (domain: string) => {
	if (RESERVED_EXACT.has(domain)) return true;
	const tld = domain.split(".").pop() ?? "";
	return RESERVED_SUFFIXES.includes(tld) || domainAndParents(domain).some((d) => RESERVED_EXACT.has(d));
};

let disposableCache: { exact: Set<string>; wildcard: Set<string> } | null = null;

/** The package's lists plus EXTRA_DISPOSABLE_DOMAINS, loaded once into Sets (about 120,000 exact, 400 wildcard). */
export const disposableLists = () => {
	if (!disposableCache) {
		/* eslint-disable @typescript-eslint/no-require-imports */
		const exact: string[] = require("disposable-email-domains");
		const wildcard: string[] = require("disposable-email-domains/wildcard.json");
		/* eslint-enable @typescript-eslint/no-require-imports */
		disposableCache = {
			exact: new Set([...exact.map((d) => d.toLowerCase()), ...EXTRA_DISPOSABLE_DOMAINS]),
			wildcard: new Set(wildcard.map((d) => d.toLowerCase())),
		};
	}
	return disposableCache;
};

export const isDisposableDomain = (
	domain: string,
	lists: { disposableExact: ReadonlySet<string>; disposableWildcard: ReadonlySet<string> },
) => listedDomain(lists.disposableExact, domain) || listedDomain(lists.disposableWildcard, domain);

export const isFreeMailDomain = (domain: string) => {
	if (FREE_MAIL_DOMAINS.has(domain)) return true;
	const dot = domain.indexOf(".");
	return dot > 0 && FREE_MAIL_BRANDS.has(domain.slice(0, dot)) && BRAND_SUFFIX.test(domain.slice(dot + 1));
};

// --- Address rules shared by sign-up and sending ---------------------------------------------------------------------

export type AddressProblem =
	| { code: "typo_domain"; suggestion: string }
	| { code: "impossible_gmail" }
	| { code: "placeholder_address" };

/** Gmail's own rule: 6-30 letters and digits (dots ignored), dots only between characters, never two together. */
export const isPossibleGmailLocal = (local: string) => {
	if (!/^[a-z0-9.]+$/i.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes(".."))
		return false;
	const length = local.replace(/\./g, "").length;
	return length >= 6 && length <= 30;
};

/**
 * Typo domain, impossible Gmail address or placeholder on a free provider, for a syntactically valid address. A
 * +tag is ignored here (sending allows it; sign-up refuses it separately).
 */
export const addressProblem = (local: string, domain: string): AddressProblem | null => {
	const lowerLocal = local.toLowerCase();
	const untagged = lowerLocal.split("+")[0];
	const typo = TYPO_DOMAINS[domain];
	if (typo) return { code: "typo_domain", suggestion: `${lowerLocal}@${typo}` };
	const gmail = GMAIL_DOMAINS.has(domain);
	if (gmail && !isPossibleGmailLocal(untagged)) return { code: "impossible_gmail" };
	if (isFreeMailDomain(domain) && PLACEHOLDER.test(gmail ? untagged.replace(/\./g, "") : untagged)) {
		return { code: "placeholder_address" };
	}
	return null;
};

// --- Sign-up --------------------------------------------------------------------------------------------------------

export type SignupEmailCode =
	| "invalid_address"
	| "plus_tag"
	| "typo_domain"
	| "impossible_gmail"
	| "placeholder_address"
	| "reserved_domain"
	| "disposable_domain";

export type SignupEmailAssessment =
	| { ok: true; email: string; canonical: string }
	| { ok: false; code: SignupEmailCode; message: string; suggestion?: string };

const refuse = (code: Exclude<SignupEmailCode, "typo_domain" | "reserved_domain" | "disposable_domain">) =>
	({ ok: false, code, message: SIGNUP_EMAIL_MESSAGES[code] }) as const;

/**
 * Whether an address may be used to sign up. `allowedDomains` (EMAIL_ALLOWED_DOMAINS) exempts a domain from the
 * reserved and disposable rules, as it does for the send-time policy.
 */
export const assessSignupEmail = (
	input: unknown,
	options: { allowedDomains?: ReadonlySet<string> } = {},
): SignupEmailAssessment => {
	const email = normaliseEmail(input);
	const parts = split(email);
	if (!parts || email.length > 254 || !isValidAddress(parts.local, parts.domain)) return refuse("invalid_address");
	const { local, domain } = parts;
	if (local.includes("+")) return refuse("plus_tag");
	const problem = addressProblem(local, domain);
	if (problem?.code === "typo_domain") {
		return {
			ok: false,
			code: "typo_domain",
			message: `Did you mean ${problem.suggestion}?`,
			suggestion: problem.suggestion,
		};
	}
	if (problem) return refuse(problem.code);
	if (!options.allowedDomains || !listedDomain(options.allowedDomains, domain)) {
		if (isReservedDomain(domain)) {
			return { ok: false, code: "reserved_domain", message: SIGNUP_EMAIL_MESSAGES.undeliverable };
		}
		const lists = disposableLists();
		if (isDisposableDomain(domain, { disposableExact: lists.exact, disposableWildcard: lists.wildcard })) {
			return { ok: false, code: "disposable_domain", message: SIGNUP_EMAIL_MESSAGES.undeliverable };
		}
	}
	return { ok: true, email, canonical: canonicalEmail(email) };
};
