// Recipient policy: which addresses this server will never email. Applied by lib/email.ts before every send and by
// sign-up before an account is created. Bounces to throwaway, fake and demo addresses damage the sending domain's
// reputation, and Resend suppresses an address after it bounces once.
//
// Order (first match decides):
//   1. EMAIL_ALLOWED_DOMAINS (domain or a parent listed) skips the domain rules 5-8, for false positives.
//   2. The shared demo accounts (config/demoAccounts.ts) are never emailed, allow-list or not.
//   3. Syntactically invalid addresses, then (lib/emailAddress.ts) typo domains of the big providers (gmai.com),
//      impossible Gmail addresses (shorter than 6 characters) and placeholders on free providers (test1@gmail.com).
//      A +tag is allowed here; only sign-up refuses it.
//   4. (allow-listed addresses stop here and are allowed)
//   5. Reserved and test domains: example.com/.net/.org and anything under .test, .example, .invalid, .localhost, .local.
//   6. Disposable inbox providers (package disposable-email-domains: exact list, and a wildcard list whose subdomains
//      are disposable, plus EXTRA_DISPOSABLE_DOMAINS), matching the domain and its parent domains.
//   7. EMAIL_BLOCKED_DOMAINS (domain or a parent listed).
//   8. DNS: a definite "no such domain" or "no mail server" (no MX and no A/AAAA, or a null MX) blocks. A timeout or
//      resolver error allows: this guards deliverability, it is not access control.
import { promises as dnsPromises } from "dns";
import { DEMO_ACCOUNT_EMAILS } from "../config/demoAccounts";
import {
	addressProblem,
	disposableLists,
	isDisposableDomain,
	isReservedDomain,
	isValidAddress,
	listedDomain as listed,
	normalizeAddress,
} from "./emailAddress";

// The address and domain rules live in lib/emailAddress.ts (one source for sign-up and sending); re-exported here.
export {
	disposableLists,
	domainAndParents,
	isDisposableDomain,
	isReservedDomain,
	isValidAddress,
	normalizeAddress,
} from "./emailAddress";

export type BlockReason =
	| "demo_account"
	| "invalid_address"
	| "typo_domain"
	| "impossible_gmail"
	| "placeholder_address"
	| "reserved_domain"
	| "disposable_domain"
	| "blocked_domain"
	| "domain_not_found"
	| "no_mail_server";

export type PolicyDecision =
	| { allowed: true; domain: string; via: "allow_list" | "rules" | "dns_error" }
	| { allowed: false; domain: string | null; reason: BlockReason };

export interface PolicyConfig {
	allowedDomains: ReadonlySet<string>;
	blockedDomains: ReadonlySet<string>;
	demoEmails: ReadonlySet<string>;
	disposableExact: ReadonlySet<string>;
	disposableWildcard: ReadonlySet<string>;
}

export const parseDomainList = (value: string | undefined) =>
	new Set(
		(value ?? "")
			.split(",")
			.map((domain) => domain.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, ""))
			.filter(Boolean),
	);

/** Rules 1-7 (everything except DNS). `needsDns` is true when the address passed and the DNS rule still applies. */
export const checkRecipientStatic = (email: unknown, config: PolicyConfig): PolicyDecision & { needsDns?: boolean } => {
	const normalized = normalizeAddress(email);
	const domain = normalized?.domain ?? null;
	if (normalized && config.demoEmails.has(normalized.address.toLowerCase())) {
		return { allowed: false, domain, reason: "demo_account" };
	}
	if (!normalized || !isValidAddress(normalized.local, normalized.domain)) {
		return { allowed: false, domain, reason: "invalid_address" };
	}
	const problem = addressProblem(normalized.local, normalized.domain);
	if (problem) return { allowed: false, domain, reason: problem.code };
	if (listed(config.allowedDomains, normalized.domain))
		return { allowed: true, domain: normalized.domain, via: "allow_list" };
	if (isReservedDomain(normalized.domain)) return { allowed: false, domain, reason: "reserved_domain" };
	if (isDisposableDomain(normalized.domain, config)) return { allowed: false, domain, reason: "disposable_domain" };
	if (listed(config.blockedDomains, normalized.domain)) return { allowed: false, domain, reason: "blocked_domain" };
	return { allowed: true, domain: normalized.domain, via: "rules", needsDns: true };
};

// --- DNS ---------------------------------------------------------------------------------------------------------

export type MailDnsOutcome = "has_mail" | "no_domain" | "no_mail" | "error";

export interface DnsResolver {
	resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
	resolve4(domain: string): Promise<string[]>;
	resolve6(domain: string): Promise<string[]>;
}

const NOT_FOUND = new Set(["ENOTFOUND", "NXDOMAIN"]);
const NO_DATA = new Set(["ENODATA", "NODATA"]);

const classify = (error: any): "not_found" | "no_data" | "error" =>
	NOT_FOUND.has(error?.code) ? "not_found" : NO_DATA.has(error?.code) ? "no_data" : "error";

/**
 * Whether a domain can receive mail (RFC 5321 section 5.1): its MX records, or with none, an A/AAAA record (the
 * implicit MX). A null MX ("." per RFC 7505) means it accepts no mail.
 */
export const lookupMailDomain = async (resolver: DnsResolver, domain: string): Promise<MailDnsOutcome> => {
	try {
		const records = await resolver.resolveMx(domain);
		if (records.length === 0) return lookupAddressRecords(resolver, domain);
		const nullMx = records.every((record) => record.exchange === "" || record.exchange === ".");
		return nullMx ? "no_mail" : "has_mail";
	} catch (error) {
		const kind = classify(error);
		if (kind === "not_found") return "no_domain";
		if (kind === "no_data") return lookupAddressRecords(resolver, domain);
		return "error";
	}
};

const lookupAddressRecords = async (resolver: DnsResolver, domain: string): Promise<MailDnsOutcome> => {
	const results = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
	if (results.some((r) => r.status === "fulfilled" && r.value.length > 0)) return "has_mail";
	const kinds = results.map((r) => (r.status === "rejected" ? classify(r.reason) : "no_data"));
	if (kinds.includes("error")) return "error";
	return kinds.every((k) => k === "not_found") ? "no_domain" : "no_mail";
};

export const DNS_TIMEOUT_MS = 2000;
export const DNS_POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
export const DNS_NEGATIVE_TTL_MS = 60 * 60 * 1000;
const DNS_CACHE_MAX = 5000;

/** Cached, time-limited DNS check. Definite answers are cached (6 h yes, 1 h no); errors and timeouts are not. */
export class MailDomainChecker {
	private readonly cache = new Map<string, { outcome: MailDnsOutcome; until: number }>();

	constructor(
		private readonly resolver: DnsResolver,
		private readonly timeoutMs = DNS_TIMEOUT_MS,
		private readonly now: () => number = Date.now,
	) {}

	async check(domain: string): Promise<MailDnsOutcome> {
		const cached = this.cache.get(domain);
		if (cached && cached.until > this.now()) return cached.outcome;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<MailDnsOutcome>((resolve) => {
			timer = setTimeout(() => resolve("error"), this.timeoutMs);
		});
		const outcome = await Promise.race([
			lookupMailDomain(this.resolver, domain).catch(() => "error" as const),
			timeout,
		]);
		if (timer) clearTimeout(timer);
		if (outcome !== "error") {
			if (this.cache.size >= DNS_CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
			this.cache.set(domain, {
				outcome,
				until: this.now() + (outcome === "has_mail" ? DNS_POSITIVE_TTL_MS : DNS_NEGATIVE_TTL_MS),
			});
		}
		return outcome;
	}
}

/** Full policy: the static rules, then DNS for addresses that passed them. Never throws. */
export const checkRecipient = async (
	email: unknown,
	config: PolicyConfig,
	checker: Pick<MailDomainChecker, "check">,
): Promise<PolicyDecision> => {
	const decision = checkRecipientStatic(email, config);
	if (!decision.allowed || !decision.needsDns) {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { needsDns, ...rest } = decision as PolicyDecision & { needsDns?: boolean };
		return rest;
	}
	const outcome = await checker.check(decision.domain).catch(() => "error" as const);
	if (outcome === "no_domain") return { allowed: false, domain: decision.domain, reason: "domain_not_found" };
	if (outcome === "no_mail") return { allowed: false, domain: decision.domain, reason: "no_mail_server" };
	return { allowed: true, domain: decision.domain, via: outcome === "error" ? "dns_error" : "rules" };
};

// --- Process-wide defaults -----------------------------------------------------------------------------------------

export const policyConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): PolicyConfig => {
	const lists = disposableLists();
	return {
		allowedDomains: parseDomainList(env.EMAIL_ALLOWED_DOMAINS),
		blockedDomains: parseDomainList(env.EMAIL_BLOCKED_DOMAINS),
		demoEmails: DEMO_ACCOUNT_EMAILS,
		disposableExact: lists.exact,
		disposableWildcard: lists.wildcard,
	};
};

let defaultConfig: PolicyConfig | null = null;
let defaultChecker: MailDomainChecker | null = null;

const systemResolver = (): DnsResolver => {
	const resolver = new dnsPromises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
	return {
		resolveMx: (d) => resolver.resolveMx(d),
		resolve4: (d) => resolver.resolve4(d),
		resolve6: (d) => resolver.resolve6(d),
	};
};

/** The policy with this process's configuration and DNS cache. */
export const checkRecipientDefault = (email: unknown) => {
	defaultConfig ??= policyConfigFromEnv();
	defaultChecker ??= new MailDomainChecker(systemResolver());
	return checkRecipient(email, defaultConfig, defaultChecker);
};

/** Loads the lists now (call at start-up so the first request does not pay for it). */
export const warmEmailPolicy = () => {
	defaultConfig ??= policyConfigFromEnv();
};
