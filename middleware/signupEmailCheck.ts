import { NextFunction, Request, Response } from "express";
import { validationResult } from "express-validator";
import { assessSignupEmail, SIGNUP_EMAIL_MESSAGES } from "../lib/emailAddress";
import { checkRecipientDefault, parseDomainList, type PolicyDecision } from "../lib/emailPolicy";
import { emitEvent } from "../lib/events";
import { hashEmail } from "../lib/redact";

export const UNDELIVERABLE_SIGNUP_MESSAGE = SIGNUP_EMAIL_MESSAGES.undeliverable;

/**
 * The 400 for a refused sign-up email: the validators' shape ({ message, errors }) plus the field, a stable code, and
 * the corrected address when there is one.
 */
export const signupEmailRefusal = (code: string, message: string, suggestion?: string) => ({
	message,
	errors: [{ path: "email", msg: message, location: "body" }],
	field: "email" as const,
	code,
	...(suggestion ? { suggestion } : {}),
});

/**
 * What sign-up does with a policy decision. Sign-up depends on the verification email, so an address the policy
 * would never email is refused before any account exists.
 */
export const signupDecision = (decision: PolicyDecision) =>
	decision.allowed
		? ({ reject: false } as const)
		: ({
				reject: true,
				status: 400,
				body: signupEmailRefusal(decision.reason, UNDELIVERABLE_SIGNUP_MESSAGE),
				reason: decision.reason,
			} as const);

let allowedDomains: ReadonlySet<string> | null = null;

type PolicyCheck = (email: unknown) => Promise<PolicyDecision>;

export type NewEmailCheck =
	| { ok: true; email: string }
	| { ok: false; reason: string; domain: string | null; body: ReturnType<typeof signupEmailRefusal> };

/**
 * The checks for an email a person gives for a new account: the address rules (lib/emailAddress.ts: syntax, +tag,
 * typo domains, impossible Gmail, placeholders, reserved and disposable domains), then the recipient policy with its
 * mail-server check (which allows when DNS errors or times out). An accepted address comes back normalised.
 */
export const checkNewAccountEmail = async (
	email: unknown,
	check: PolicyCheck = checkRecipientDefault,
): Promise<NewEmailCheck> => {
	allowedDomains ??= parseDomainList(process.env.EMAIL_ALLOWED_DOMAINS);
	const assessment = assessSignupEmail(email, { allowedDomains });
	if (!assessment.ok) {
		const domain = typeof email === "string" ? (email.split("@").pop()?.trim().toLowerCase() ?? null) : null;
		const body = signupEmailRefusal(assessment.code, assessment.message, assessment.suggestion);
		return { ok: false, reason: assessment.code, domain, body };
	}
	const decision = await check(assessment.email).catch(() => null);
	const outcome = decision ? signupDecision(decision) : ({ reject: false } as const);
	if (outcome.reject)
		return { ok: false, reason: outcome.reason, domain: decision?.domain ?? null, body: outcome.body };
	return { ok: true, email: assessment.email };
};

/**
 * Sign-up gate, mounted after the rate limiter and the field validators. Requests that failed validation pass
 * through so the handler answers them exactly as before. A refused address gets 400 before any account exists; an
 * accepted one continues normalised.
 */
export const rejectUndeliverableSignup =
	(role: "customer" | "provider", check: PolicyCheck = checkRecipientDefault) =>
	async (req: Request, res: Response, next: NextFunction) => {
		if (!validationResult(req).isEmpty()) return next();
		const email = req.body?.email;
		const result = await checkNewAccountEmail(email, check);
		if (!result.ok) {
			emitEvent(
				{
					type: "signup.blocked",
					properties: {
						reason: result.reason,
						role,
						recipientDomain: result.domain,
						recipientHash: typeof email === "string" ? hashEmail(email) : null,
					},
				},
				req,
			);
			return res.status(400).json(result.body);
		}
		req.body.email = result.email;
		next();
	};
