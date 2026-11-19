import { NextFunction, Request, Response } from "express";
import { validationResult } from "express-validator";
import { checkRecipientDefault, type PolicyDecision } from "../lib/emailPolicy";
import { emitEvent } from "../lib/events";
import { hashEmail } from "../lib/redact";

export const UNDELIVERABLE_SIGNUP_MESSAGE = "Use a permanent email address you can receive mail at.";

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
				body: { message: UNDELIVERABLE_SIGNUP_MESSAGE },
				reason: decision.reason,
			} as const);

/**
 * Sign-up gate, mounted after the rate limiter and the field validators. Requests that failed validation pass
 * through so the handler answers them exactly as before.
 */
export const rejectUndeliverableSignup =
	(role: "customer" | "provider", check: (email: unknown) => Promise<PolicyDecision> = checkRecipientDefault) =>
	async (req: Request, res: Response, next: NextFunction) => {
		if (!validationResult(req).isEmpty()) return next();
		const email = req.body?.email;
		const decision = await check(email).catch(() => null);
		if (!decision) return next();
		const outcome = signupDecision(decision);
		if (!outcome.reject) return next();
		emitEvent(
			{
				type: "signup.blocked",
				properties: {
					reason: outcome.reason,
					role,
					recipientDomain: decision.domain,
					recipientHash: typeof email === "string" ? hashEmail(email) : null,
				},
			},
			req,
		);
		return res.status(outcome.status).json(outcome.body);
	};
