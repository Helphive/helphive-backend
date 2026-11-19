// The one way to write the admin audit log. Every admin write and every admin sign-in attempt calls recordAudit().
// It never throws: a failure to record is logged at ERROR (alertable) and the request carries on.
import type { Request } from "express";
import mongoose from "mongoose";
import AuditLogModel from "../dal/models/auditLog.model";
import { getRequestContext, type RequestContext } from "./requestContext";
import { maskEmail, redact, type RedactOptions } from "./redact";
import { EventSampler } from "./events";
import log from "./logger";

/** Stable action names. Add new ones here (and to backend-platform.md); never rename one in use. */
export const AUDIT_ACTIONS = {
	"auth.login.succeeded": "Signed in (password, and the second step when it is on).",
	"auth.login.failed": "Sign-in refused: wrong email or password, disabled admin, or expired one-time password.",
	"auth.login.mfa_required": "Password accepted; a two-step challenge was issued.",
	"auth.login.mfa_failed": "Two-step code or recovery code refused during sign-in.",
	"auth.logout": "Signed out of this session.",
	"auth.logout_all": "Signed out of every session.",
	"auth.session.revoked": "Ended one of their own sessions.",
	"auth.session.reuse_detected": "An already-used refresh token was presented; the session was revoked.",
	"account.password.changed": "Changed their own password (other sessions signed out).",
	"account.mfa.enrollment_started": "Started setting up two-step sign-in.",
	"account.mfa.enabled": "Turned two-step sign-in on.",
	"account.mfa.disabled": "Turned two-step sign-in off.",
	"account.mfa.recovery_codes_regenerated": "Replaced their recovery codes.",
	"account.mfa.recovery_code_used": "Used a recovery code to sign in.",
	"admins.created": "Created an admin with a one-time password (legacy /admin/signup also records this).",
	"admins.role_changed": "Changed an admin's role.",
	"admins.disabled": "Disabled an admin (all their sessions end).",
	"admins.enabled": "Re-enabled an admin.",
	"admins.signed_out": "Signed an admin out of every session.",
	"admins.mfa_reset": "Turned off another admin's two-step sign-in.",
	"applications.approved": "Approved a provider application.",
	"applications.rejected": "Rejected a provider application.",
	"demo.write_refused": "The demo admin tried a write; refused (sampled, metadata.demo = true).",
	"users.suspended": "Suspended a customer or provider: sign-in, refresh, the API and the provider socket refused.",
	"users.reinstated": "Lifted a suspension.",
	"users.sessions_ended": "Ended every app session of a customer or provider.",
	"users.email_verified": "Marked a customer's or provider's email as verified.",
	"users.verification_email_sent": "Resent the verification email (subject to the email policy).",
	"users.availability_off": "Turned a provider's availability off.",
	"notes.created": "Added an admin note.",
	"notes.updated": "Edited an admin note.",
	"notes.deleted": "Deleted an admin note (kept, marked deleted).",
	"bookings.cancelled": "Cancelled a booking on behalf of the customer or the provider (app refund rules).",
	"bookings.released": "Removed the provider from an accepted booking so another provider can accept it.",
	"bookings.resolved_completed": "Marked a stuck in-progress booking completed (the provider's earning is created).",
	"bookings.resolved_cancelled": "Cancelled a stuck in-progress booking (full refund or none, as chosen).",
	"payments.refunded": "Refunded a payment in full or in part through Stripe.",
	"finance.reconciliation_run": "Ran a reconciliation with Stripe over a date range (reads Stripe only).",
	"finance.mismatch_explained": "Marked a reconciliation mismatch explained, with a note.",
	"settings.updated": "Changed a platform setting (before and after values in the summary).",
	"support.case_opened": "Opened a support case.",
	"support.case_updated": "Changed a support case's status, priority, category or assignee.",
	"support.case_note_added": "Added an internal note to a support case.",
	"support.case_message_sent": "Emailed the customer or provider from a support case (subject to the email policy).",
	"support.case_action_linked": "Linked a refund or another action to a support case.",
	"support.case_resolved": "Resolved a support case.",
	"notifications.sent": "Sent an announcement to a segment by push and/or email.",
	"notifications.template_saved": "Created or changed an announcement template.",
	"notifications.template_deleted": "Deleted an announcement template.",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export interface AuditActor {
	type: "admin" | "anonymous" | "system";
	id?: string | mongoose.Types.ObjectId | null;
	email?: string | null;
}

export interface AuditInput {
	action: AuditAction;
	outcome?: "success" | "failure";
	actor: AuditActor;
	target?: { type: string; id?: string | mongoose.Types.ObjectId | null } | null;
	before?: unknown;
	after?: unknown;
	reason?: string | null;
	metadata?: Record<string, unknown>;
	/** Keys in before/after holding document paths or links (shown as "[document]"). */
	documentKeys?: readonly string[];
	/**
	 * The public demo admin: recorded with metadata.demo = true, and sampled (first per action and address every
	 * 10 minutes, at most 30 a minute per instance) so the public login cannot flood the log.
	 */
	demo?: boolean;
}

const MAX_REASON = 1000;

/** The document to insert, built from the input and the request context. Pure; exported for tests. */
export const buildAuditEntry = (input: AuditInput, context: RequestContext | undefined, now = new Date()) => {
	const options: RedactOptions = { documentKeys: input.documentKeys, maskEmails: false, maxDepth: 4 };
	const actorId = input.actor.id ? String(input.actor.id) : null;
	const knownAdmin = input.actor.type === "admin" && actorId && mongoose.Types.ObjectId.isValid(actorId);
	// The acting admin's email is the record of who it was. An email typed at a failed sign-in may not be anyone's
	// (or may be a password typed in the wrong box), so it is masked.
	const email = input.actor.email ? (knownAdmin ? input.actor.email : maskEmail(input.actor.email)) : null;
	const summary =
		input.before !== undefined || input.after !== undefined
			? {
					...(input.before !== undefined ? { before: redact(input.before, options) } : {}),
					...(input.after !== undefined ? { after: redact(input.after, options) } : {}),
				}
			: null;
	return {
		at: now,
		action: input.action,
		outcome: input.outcome ?? "success",
		actor: {
			type: input.actor.type,
			id: knownAdmin ? new mongoose.Types.ObjectId(actorId) : null,
			email: email ? email.slice(0, 255) : null,
		},
		target: input.target ? { type: input.target.type, id: input.target.id ? String(input.target.id) : null } : null,
		summary,
		reason: input.reason ? String(input.reason).slice(0, MAX_REASON) : null,
		metadata: input.metadata ? (redact(input.metadata, options) as Record<string, unknown>) : null,
		ip: context?.ip ?? null,
		userAgent: context?.userAgent ?? null,
		requestId: context?.requestId ?? null,
	};
};

/** The signed-in admin as an audit actor. */
export const adminActor = (req: Request): AuditActor => {
	const admin = (req as Request & { admin?: { _id: mongoose.Types.ObjectId; email: string } }).admin;
	return admin ? { type: "admin", id: admin._id, email: admin.email } : { type: "anonymous" };
};

const demoSampler = new EventSampler(10 * 60 * 1000, 30);

/** Inserts one entry. Awaited by callers so the entry exists before the response; never throws. */
export const recordAudit = async (input: AuditInput, req?: Request): Promise<void> => {
	try {
		const context = req?.context ?? getRequestContext();
		if (input.demo) {
			const sample = demoSampler.take(`${input.action}|${context?.ip ?? "?"}`);
			if (!sample) return;
			input = { ...input, metadata: { ...input.metadata, demo: true, similarNotRecorded: sample.suppressed } };
		}
		const entry = buildAuditEntry(input, context);
		await AuditLogModel.create(entry);
	} catch (error) {
		log.error(`Could not write audit entry ${input.action}`, error);
	}
};
