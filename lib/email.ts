// The one outbound email module. Every email and every Resend audience contact goes through here, so the recipient
// policy (lib/emailPolicy.ts) applies to all of them. Never throws: callers get a typed result.
import type { ReactElement } from "react";
import { Resend } from "resend";
import { checkRecipientDefault, type BlockReason, type PolicyDecision } from "./emailPolicy";
import { emitEvent } from "./events";
import { hashEmail, maskEmail } from "./redact";
import log from "./logger";

export type EmailTemplate =
	| "verify-email"
	| "reset-password"
	| "refund"
	| "audience-contact"
	| "support-message"
	| "announcement"
	| "observability-alert";

export type EmailResult =
	| { status: "sent"; messageId: string | null }
	| { status: "skipped"; reason: BlockReason }
	| { status: "failed"; error: string };

export interface SendEmailInput {
	template: EmailTemplate;
	from: string;
	to: string;
	subject: string;
	react: ReactElement;
	/** The account this email is about, for the event record. */
	userId?: string | null;
}

let client: Resend | null = null;
const resend = () => (client ??= new Resend(process.env.RESEND_API_KEY));

type PolicyCheck = (email: unknown) => Promise<PolicyDecision>;
let policy: PolicyCheck = checkRecipientDefault;

/** Tests replace the policy and the provider. */
export const setEmailDependencies = (deps: { policy?: PolicyCheck; client?: Resend }) => {
	if (deps.policy) policy = deps.policy;
	if (deps.client) client = deps.client;
};

const recordSkip = (template: EmailTemplate, to: string, reason: BlockReason, userId?: string | null) => {
	const domain = to.split("@").pop()?.toLowerCase() ?? null;
	log.info(`Email ${template} not sent: ${reason}`, {
		template,
		reason,
		recipient: maskEmail(to),
		recipientHash: hashEmail(to),
	});
	emitEvent({
		type: "email.skipped",
		subjects: { userId },
		properties: { template, reason, recipientDomain: domain, recipientHash: hashEmail(to) },
	});
};

/** Decides whether `to` may be emailed and records a skip. Exposed for flows that must check before acting. */
export const emailAllowed = async (template: EmailTemplate, to: string, userId?: string | null) => {
	let decision: PolicyDecision;
	try {
		decision = await policy(to);
	} catch (error) {
		// The policy never throws by design; if it did, sending is the safer failure for transactional mail.
		log.error("Email recipient policy failed; sending anyway", error);
		return { allowed: true as const };
	}
	if (!decision.allowed) recordSkip(template, to, decision.reason, userId);
	return decision.allowed ? { allowed: true as const } : { allowed: false as const, reason: decision.reason };
};

export const sendEmail = async (input: SendEmailInput): Promise<EmailResult> => {
	const check = await emailAllowed(input.template, input.to, input.userId);
	if (!check.allowed) return { status: "skipped", reason: check.reason };
	try {
		const { data, error } = await resend().emails.send({
			from: input.from,
			to: [input.to],
			subject: input.subject,
			react: input.react,
		});
		if (error) {
			const message = String((error as { message?: unknown }).message ?? error);
			log.error(`Email ${input.template} was refused by the provider`, { template: input.template, message });
			return { status: "failed", error: message };
		}
		emitEvent({
			type: "email.sent",
			subjects: { userId: input.userId },
			properties: {
				template: input.template,
				messageId: data?.id ?? null,
				recipientDomain: input.to.split("@").pop()?.toLowerCase() ?? null,
			},
		});
		return { status: "sent", messageId: data?.id ?? null };
	} catch (error) {
		log.error(`Email ${input.template} could not be sent`, error);
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
};

/** Adds a sign-up to the Resend audience, under the same policy (a blocked address is skipped, not added). */
export const addAudienceContact = async (input: {
	email: string;
	firstName?: string;
	lastName?: string;
	userId?: string | null;
}): Promise<EmailResult> => {
	const check = await emailAllowed("audience-contact", input.email, input.userId);
	if (!check.allowed) return { status: "skipped", reason: check.reason };
	// Resend 6 treats an empty audienceId as "no audience" and would create an unlisted contact; never do that.
	const audienceId = process.env.RESEND_AUDIENCE_ID;
	if (!audienceId) return { status: "failed", error: "RESEND_AUDIENCE_ID is not set" };
	try {
		const response = await resend().contacts.create({
			email: input.email,
			firstName: input.firstName,
			lastName: input.lastName,
			unsubscribed: false,
			audienceId,
		});
		if (response.error) {
			const message = String((response.error as { message?: unknown }).message ?? response.error);
			return { status: "failed", error: message };
		}
		return { status: "sent", messageId: response.data?.id ?? null };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
};

/**
 * Adds a person to the audience once their email is verified (never at sign-up, so an address nobody confirmed is
 * never a contact). Never throws: verifying an email must not depend on Resend.
 */
export const addVerifiedContact = async (user: {
	_id?: unknown;
	email: string;
	firstName?: string;
	lastName?: string;
}): Promise<void> => {
	try {
		const result = await addAudienceContact({
			email: user.email,
			firstName: user.firstName,
			lastName: user.lastName,
			userId: user._id ? String(user._id) : null,
		});
		if (result.status === "failed") log.error("Audience contact could not be added", new Error(result.error));
	} catch (error) {
		log.error("Audience contact could not be added", error);
	}
};
