// Shared demo logins that ship inside the web and mobile apps. Anyone can sign in to them, so account-level
// actions (profile, password, provider application, Stripe account setup) are turned off for them.
const DEFAULT_DEMO_ACCOUNT_EMAILS = ["user@helphive.himaiz.com", "provider@helphive.himaiz.com"];

// The addresses the demo accounts had until 2026-11-21. App builds up to Production 14 still sign in with them, and
// sessions issued before the change carry them, so they resolve to the current address. They stay demo addresses,
// so nobody can sign up with them and nothing is ever emailed to them.
const LEGACY_DEMO_ACCOUNT_EMAILS: Readonly<Record<string, string>> = {
	"user@helphivenow.com": "user@helphive.himaiz.com",
	"provider@helphivenow.com": "provider@helphive.himaiz.com",
};

const normalize = (email: string) => email.trim().toLowerCase();

// DEMO_ACCOUNT_EMAILS (comma separated) replaces the defaults when set; the legacy addresses are always included.
export const DEMO_ACCOUNT_EMAILS: ReadonlySet<string> = new Set(
	[
		...(process.env.DEMO_ACCOUNT_EMAILS?.trim()
			? process.env.DEMO_ACCOUNT_EMAILS.split(",")
			: DEFAULT_DEMO_ACCOUNT_EMAILS),
		...Object.keys(LEGACY_DEMO_ACCOUNT_EMAILS),
	]
		.map(normalize)
		.filter(Boolean),
);

/** The demo account's current address for one of its old addresses; any other email unchanged. */
export const currentDemoAccountEmail = (email: string): string => LEGACY_DEMO_ACCOUNT_EMAILS[normalize(email)] ?? email;

export const DEMO_ACCOUNT_BLOCKED_MESSAGE = "This action is turned off for the shared demo accounts.";

export const isDemoAccountEmail = (email: unknown): boolean =>
	typeof email === "string" && DEMO_ACCOUNT_EMAILS.has(normalize(email));

// The public demo login for the admin console. Any admin with one of these emails is the read-only "demo" role,
// whatever its stored role says (config/adminPermissions.ts). DEMO_ADMIN_EMAILS (comma separated) replaces the default.
const DEFAULT_DEMO_ADMIN_EMAILS = ["demo.admin@helphive.himaiz.com"];

export const demoAdminEmails = (value = process.env.DEMO_ADMIN_EMAILS): ReadonlySet<string> =>
	new Set((value?.trim() ? value.split(",") : DEFAULT_DEMO_ADMIN_EMAILS).map(normalize).filter(Boolean));

export const DEMO_ADMIN_EMAILS = demoAdminEmails();

export const isDemoAdminEmail = (email: unknown): boolean =>
	typeof email === "string" && DEMO_ADMIN_EMAILS.has(normalize(email));

export const DEMO_ADMIN_READ_ONLY = {
	message: "This action is turned off for the demo admin.",
	code: "demo_read_only",
} as const;
