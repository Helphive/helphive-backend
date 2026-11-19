// Shared demo logins that ship inside the web and mobile apps. Anyone can sign in to them, so account-level
// actions (profile, password, provider application, Stripe account setup) are turned off for them.
const DEFAULT_DEMO_ACCOUNT_EMAILS = ["user@helphivenow.com", "provider@helphivenow.com"];

const normalize = (email: string) => email.trim().toLowerCase();

// DEMO_ACCOUNT_EMAILS (comma separated) replaces the defaults when set.
export const DEMO_ACCOUNT_EMAILS: ReadonlySet<string> = new Set(
	(process.env.DEMO_ACCOUNT_EMAILS?.trim() ? process.env.DEMO_ACCOUNT_EMAILS.split(",") : DEFAULT_DEMO_ACCOUNT_EMAILS)
		.map(normalize)
		.filter(Boolean),
);

export const DEMO_ACCOUNT_BLOCKED_MESSAGE = "This action is turned off for the shared demo accounts.";

export const isDemoAccountEmail = (email: unknown): boolean =>
	typeof email === "string" && DEMO_ACCOUNT_EMAILS.has(normalize(email));
