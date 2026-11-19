// Every business event type, who emits it, the subject ids it carries and its properties. backend-platform.md is
// written from this list; tests check that every emitted type is listed here. Money is in dollars (as stored).

export interface EventTypeDoc {
	description: string;
	subjects: readonly string[];
	properties: Record<string, string>;
}

export const EVENT_CATALOGUE = {
	"user.signed_up": {
		description: "A customer or provider account was created (before email verification).",
		subjects: ["userId"],
		properties: { role: "customer | provider" },
	},
	"user.email_verified": {
		description: "The verification link was used, or an admin marked the email verified.",
		subjects: ["userId"],
		properties: { by: "admin, when an admin marked it (absent for the link)" },
	},
	"user.suspended": {
		description: "An admin suspended the account; its sessions ended and provider availability went off.",
		subjects: ["userId", "providerId (providers)"],
		properties: { upcomingBookings: "open bookings the person is part of (not cancelled automatically)" },
	},
	"user.reinstated": {
		description: "An admin lifted the suspension.",
		subjects: ["userId", "providerId (providers)"],
		properties: { suspendedForMs: "how long the account was suspended, when known" },
	},
	"user.profile_updated": {
		description: "The person changed their profile.",
		subjects: ["userId"],
		properties: {
			fields: "names of the fields changed (never their values)",
			photo: "true when a new photo was uploaded",
		},
	},
	"auth.sign_in_succeeded": {
		description: "Customer or provider signed in.",
		subjects: ["userId"],
		properties: { role: "customer | provider" },
	},
	"auth.sign_in_failed": {
		description: "Customer or provider sign-in refused (rate-limited attempts are not counted here).",
		subjects: ["userId (when the account exists)"],
		properties: {
			reason: "bad_credentials | email_unverified | suspended",
			emailHash: "keyed hash of the typed email, to group attempts without storing it",
		},
	},
	"auth.signed_out": {
		description: "A device session ended at the person's request.",
		subjects: ["userId"],
		properties: {},
	},
	"auth.password_reset_requested": {
		description: "A password reset was requested for an existing account.",
		subjects: ["userId"],
		properties: { emailSent: "false when the recipient policy skipped the email" },
	},
	"auth.password_reset_completed": {
		description: "The password was reset with an email link; every session was ended.",
		subjects: ["userId"],
		properties: {},
	},
	"provider.application_submitted": {
		description: "A provider sent an application with documents.",
		subjects: ["userId", "providerId", "applicationId"],
		properties: { jobTypes: "the job types applied for" },
	},
	"provider.application_reviewed": {
		description: "An admin approved or rejected an application.",
		subjects: ["providerId", "applicationId"],
		properties: {
			decision: "approved | rejected",
			reason: "rejection reason, when rejected",
			waitedMs: "time since submission",
		},
	},
	"provider.availability_changed": {
		description: "A provider went available or unavailable (not emitted for location-only updates).",
		subjects: ["providerId"],
		properties: {
			available: "new value",
			via: "http | websocket | disconnect | admin",
			jobTypes: "selected job type ids, when sent",
		},
	},
	"booking.created": {
		description: "A customer created a booking (payment follows).",
		subjects: ["userId", "bookingId"],
		properties: {
			serviceId: "1 public area, 2 room, 3 linen",
			rate: "hourly rate",
			hours: "hours",
			amount: "rate x hours",
			startDate: "start time",
			leadTimeMs: "start time minus now",
			locationSource: "search | map | current_location from the address picker (null from older apps)",
			customAddress: "true when the customer typed their own address text over the picked one",
		},
	},
	"booking.paid": {
		description: "The booking's payment succeeded (Stripe payment_intent.succeeded, first delivery).",
		subjects: ["userId", "bookingId", "paymentId"],
		properties: { amount: "amount paid" },
	},
	"booking.accepted": {
		description: "A provider accepted the booking.",
		subjects: ["userId", "providerId", "bookingId"],
		properties: { timeToAcceptMs: "accepted minus created", untilStartMs: "start time minus now" },
	},
	"booking.start_requested": {
		description: "The provider asked the customer to approve the start.",
		subjects: ["userId", "providerId", "bookingId"],
		properties: { offsetFromStartMs: "now minus the scheduled start (negative = early)" },
	},
	"booking.start_approved": {
		description: "The customer approved the start request.",
		subjects: ["userId", "providerId", "bookingId"],
		properties: { approvalWaitMs: "approved minus requested, when known" },
	},
	"booking.started": {
		description: "The booking moved to in progress (today at the same moment as start_approved).",
		subjects: ["userId", "providerId", "bookingId"],
		properties: { offsetFromStartMs: "started minus the scheduled start" },
	},
	"booking.completed": {
		description: "The booking was completed.",
		subjects: ["userId", "providerId", "bookingId"],
		properties: {
			by: "customer | provider | admin",
			durationMs: "completed minus started",
			bookedHours: "hours booked",
		},
	},
	"booking.cancelled": {
		description: "The booking was cancelled by a person (or by an admin on behalf of one).",
		subjects: ["userId", "providerId (when assigned)", "bookingId"],
		properties: {
			by: "customer | provider | admin",
			onBehalfOf: "customer | provider, when an admin cancelled",
			wasInProgress: "true when an admin cancelled a booking already in progress",
			reason: "reason text when given",
			wasAccepted: "a provider had accepted",
		},
	},
	"booking.released": {
		description: "An admin removed the provider from an accepted booking; it is open for other providers again.",
		subjects: ["userId", "providerId (the provider removed)", "bookingId"],
		properties: { untilStartMs: "start time minus now", hadStartRequest: "the provider had asked to start" },
	},
	"booking.expired": {
		description: "Nobody accepted before the start time; the booking was cancelled and refunded.",
		subjects: ["userId", "bookingId"],
		properties: {},
	},
	"payment.succeeded": {
		description: "Stripe confirmed the payment.",
		subjects: ["userId", "bookingId", "paymentId"],
		properties: { amount: "amount" },
	},
	"payment.failed": {
		description: "Stripe reported a failed payment attempt (payment_intent.payment_failed).",
		subjects: ["bookingId", "paymentId"],
		properties: { failureCode: "Stripe error code", declineCode: "card decline code" },
	},
	"refund.created": {
		description: "A refund was requested from Stripe (cancellation, expiry, or an admin refund).",
		subjects: ["bookingId", "paymentId"],
		properties: { amount: "refund amount", by: "admin, for an admin refund", partial: "less than was paid" },
	},
	"refund.succeeded": {
		description: "Stripe confirmed the refund.",
		subjects: ["bookingId", "paymentId"],
		properties: { amount: "refund amount" },
	},
	"refund.failed": {
		description: "Stripe reported the refund failed or was cancelled.",
		subjects: ["bookingId", "paymentId"],
		properties: { status: "failed | cancelled", amount: "refund amount" },
	},
	"earning.created": {
		description: "A provider earning was recorded when a booking completed.",
		subjects: ["providerId", "bookingId", "earningId"],
		properties: { amount: "provider share", releaseAt: "when the release task is scheduled" },
	},
	"earning.released": {
		description: "The earning was transferred to the provider's Stripe account.",
		subjects: ["providerId", "bookingId", "earningId"],
		properties: { amount: "amount", waitedMs: "released minus created" },
	},
	"payout.requested": {
		description: "A provider asked for a payout and Stripe accepted it.",
		subjects: ["providerId", "payoutId"],
		properties: { amount: "amount", status: "Stripe's initial status" },
	},
	"payout.paid": {
		description: "Stripe paid the payout out.",
		subjects: ["providerId", "payoutId"],
		properties: { amount: "amount" },
	},
	"payout.failed": {
		description: "Stripe reported the payout failed or was cancelled; the amount went back to the balance.",
		subjects: ["providerId", "payoutId"],
		properties: { status: "failed | cancelled", amount: "amount" },
	},
	"payout.held": {
		description: "A payout request was refused because the provider has a risk payout hold.",
		subjects: ["providerId"],
		properties: { amount: "amount asked for", hold: "hold | review" },
	},
	"earning.held": {
		description:
			"An earning release was kept back because the provider has a risk payout hold; it is rescheduled when the hold is released.",
		subjects: ["providerId", "bookingId", "earningId"],
		properties: { amount: "earning amount" },
	},
	"risk.rule_fired": {
		description: "A risk rule fired for a person (recorded once per rule, person and day).",
		subjects: ["userId"],
		properties: {
			ruleKey: "rule",
			mode: "observe | enforce",
			severity: "low..critical",
			weight: "points",
			enforced: "whether its actions were carried out",
		},
	},
	"risk.case_opened": {
		description: "A risk review case was opened by a rule in enforce mode or by an admin.",
		subjects: ["userId (when the case is about a person)"],
		properties: { caseId: "case", severity: "severity", rules: "rule keys", by: "rule | admin" },
	},
	"risk.case_updated": {
		description: "An admin assigned a case, changed its status, added a note or acted from it.",
		subjects: ["userId (when known)"],
		properties: { caseId: "case", change: "assigned | status | note | action name" },
	},
	"risk.case_decided": {
		description: "An admin cleared or confirmed a case.",
		subjects: ["userId (when known)"],
		properties: { caseId: "case", outcome: "cleared | confirmed" },
	},
	"risk.hold_placed": {
		description: "A payout hold was placed on a provider (rule in enforce mode, admin or case).",
		subjects: ["userId", "providerId"],
		properties: {
			holdId: "hold",
			kind: "hold | review_before_payout",
			by: "rule | admin | case",
			ruleKey: "rule, when by a rule",
		},
	},
	"risk.hold_released": {
		description: "An admin released a payout hold.",
		subjects: ["userId", "providerId"],
		properties: { holdId: "hold", kind: "kind", rescheduledEarnings: "earning releases scheduled again" },
	},
	"risk.rule_changed": {
		description: "An admin created or changed a risk rule.",
		subjects: [],
		properties: { ruleKey: "rule", fields: "names of the fields changed", mode: "the mode after the change" },
	},
	"risk.list_changed": {
		description: "An admin added, changed the expiry of, or removed a block or allow list entry.",
		subjects: [],
		properties: {
			entryId: "entry",
			list: "block | allow",
			kind: "email, email_domain, device, ip, ip_range, phone",
			change: "added | expiry_changed | removed",
		},
	},
	"risk.attempt_blocked": {
		description: "A sign-up, sign-in or booking was refused by the block list (the person sees a generic message).",
		subjects: [],
		properties: {
			point: "signup | signin | booking",
			kinds: "kinds of entries that matched",
			entryIds: "matching entries",
		},
	},
	"admin.action_taken": {
		description:
			"An admin write with no business event of its own (notes, ending sessions, resending verification). The audit log has the details.",
		subjects: ["userId | bookingId | paymentId | applicationId (the target)"],
		properties: { action: "the audit action name", targetType: "user | booking | payment | application" },
	},
	"chat.session_issued": {
		description: "A chat (CometChat) auth token was issued for a sign-in session.",
		subjects: ["userId", "providerId (providers)"],
		properties: { role: "customer | provider" },
	},
	"chat.relationship_opened": {
		description: "A customer and provider may now chat (a booking was accepted, or the demo pair).",
		subjects: ["userId (customer)", "providerId", "bookingId (one of the bookings allowing it)"],
		properties: {
			until: "when it ends if nothing changes (null while a booking is active)",
			bookings: "bookings allowing it",
			synced: "CometChat was updated",
		},
	},
	"chat.relationship_closed": {
		description: "A customer and provider may no longer chat (grace period over, booking released).",
		subjects: ["userId (customer)", "providerId"],
		properties: { until: "null", bookings: "0", synced: "CometChat was updated" },
	},
	"chat.message_sent": {
		description: "A chat message was sent (from the CometChat webhook). Counts and kinds only, never the text.",
		subjects: ["userId (sender)", "providerId (the provider in the conversation)"],
		properties: {
			messageId: "CometChat message id",
			receiverType: "user | group",
			category: "message | custom | action",
			type: "text | image | file | ...",
			textLength: "characters",
			attachments: "count",
			attachmentTypes: "MIME types",
			attachmentBytes: "total size",
			senderRole: "customer | provider | unknown",
			pushed: "a push notification was sent",
		},
	},
	"chat.message_removed": {
		description: "The server deleted a chat message that broke the rules.",
		subjects: ["userId (sender)"],
		properties: {
			messageId: "CometChat message id",
			reason: "attachment_type | attachment_size | attachment_unknown | no_relationship",
		},
	},
	"chat.user_blocked": {
		description: "A person blocked a counterparty in chat.",
		subjects: ["userId (who blocked)"],
		properties: { source: "api | chat" },
	},
	"chat.user_unblocked": {
		description: "A person unblocked a counterparty.",
		subjects: ["userId (who unblocked)"],
		properties: { source: "api | chat" },
	},
	"chat.message_reported": {
		description: "A person reported a chat message or user to HelpHive.",
		subjects: ["userId (reporter)"],
		properties: { category: "report category", withMessage: "a specific message was reported" },
	},
	"chat.report_resolved": {
		description: "An admin closed a chat report.",
		subjects: ["userId (reported person)"],
		properties: { status: "actioned | dismissed" },
	},
	"chat.suspended": {
		description: "An admin turned chat off for a person.",
		subjects: ["userId", "providerId (providers)"],
		properties: {},
	},
	"chat.reinstated": {
		description: "An admin turned chat back on for a person.",
		subjects: ["userId", "providerId (providers)"],
		properties: {},
	},
	"security.demo_account_blocked": {
		description: "A shared demo account tried an action that is turned off for it.",
		subjects: ["userId (when known)"],
		properties: { action: "route or flow that was blocked" },
	},
	"security.rate_limited": {
		description:
			"A rate limit refused a request. Sampled: the first per limiter and client per 10 minutes, at most 60 a minute per instance.",
		subjects: [],
		properties: {
			limiter: "limiter name",
			path: "request path",
			suppressed: "similar refusals not recorded since the last one",
		},
	},
	"dispute.created": {
		description:
			"A customer's bank opened a card dispute (chargeback) on a payment (Stripe charge.dispute.created).",
		subjects: ["userId", "providerId", "bookingId", "paymentId (when the payment is known)"],
		properties: {
			disputeId: "Stripe dispute id",
			amount: "disputed amount",
			reason: "Stripe reason code",
			status: "status",
			evidenceDueBy: "deadline to respond",
		},
	},
	"dispute.updated": {
		description: "A dispute's status or details changed.",
		subjects: ["userId", "providerId", "bookingId", "paymentId"],
		properties: { disputeId: "Stripe dispute id", amount: "amount", reason: "reason", status: "new status" },
	},
	"dispute.funds_withdrawn": {
		description: "Stripe took the disputed amount (and fee) from the platform balance.",
		subjects: ["userId", "providerId", "bookingId", "paymentId"],
		properties: { disputeId: "Stripe dispute id", amount: "amount", reason: "reason", status: "status" },
	},
	"dispute.funds_reinstated": {
		description: "Stripe returned the disputed funds to the platform balance.",
		subjects: ["userId", "providerId", "bookingId", "paymentId"],
		properties: { disputeId: "Stripe dispute id", amount: "amount", reason: "reason", status: "status" },
	},
	"dispute.closed": {
		description: "The dispute ended: won, lost, or a warning closed.",
		subjects: ["userId", "providerId", "bookingId", "paymentId"],
		properties: {
			disputeId: "Stripe dispute id",
			amount: "amount",
			reason: "reason",
			status: "status",
			outcome: "won | lost | warning_closed",
		},
	},
	"finance.reconciliation_completed": {
		description: "An admin ran a reconciliation with Stripe.",
		subjects: [],
		properties: {
			runId: "run id",
			status: "completed | partial",
			from: "range start",
			to: "range end",
			mismatches: "count",
			byType: "count per mismatch type",
		},
	},
	"settings.changed": {
		description: "An admin changed a platform setting.",
		subjects: [],
		properties: { key: "setting key", before: "previous value", after: "new value" },
	},
	"support.case_opened": {
		description: "A support case was opened.",
		subjects: ["userId | bookingId | paymentId (what the case is about)"],
		properties: {
			caseId: "case id",
			reference: "case reference",
			category: "category",
			source: "admin | customer | provider",
		},
	},
	"support.case_updated": {
		description: "A support case's status, priority, category or assignee changed, or a note or action was added.",
		subjects: ["userId | bookingId | paymentId"],
		properties: { caseId: "case id", changes: "names of the fields changed", status: "status after" },
	},
	"support.case_message_sent": {
		description: "An admin emailed a party from a support case.",
		subjects: ["userId (the recipient)", "bookingId"],
		properties: { caseId: "case id", to: "customer | provider", result: "sent | skipped | failed" },
	},
	"support.case_resolved": {
		description: "A support case was resolved.",
		subjects: ["userId | bookingId | paymentId"],
		properties: { caseId: "case id", outcome: "resolution outcome", openForMs: "time since opened" },
	},
	"notification.campaign_sent": {
		description: "An admin sent an announcement to a segment.",
		subjects: [],
		properties: {
			campaignId: "campaign id",
			segment: "segment type",
			channels: "push | email",
			targeted: "recipients",
			pushSent: "push recipients",
			emailSent: "emails sent",
			emailSkipped: "emails the policy skipped",
		},
	},
	"email.sent": {
		description: "An email was handed to the provider (Resend).",
		subjects: ["userId (when known)"],
		properties: {
			template: "template name",
			messageId: "provider's message id",
			recipientDomain: "domain of the recipient",
		},
	},
	"email.skipped": {
		description: "An email was not sent because the recipient policy blocks the address.",
		subjects: ["userId (when known)"],
		properties: {
			template: "template name",
			reason: "policy reason",
			recipientDomain: "domain",
			recipientHash: "keyed hash of the address",
		},
	},
	"signup.blocked": {
		description: "Sign-up refused because the address can never receive the verification email.",
		subjects: [],
		properties: {
			reason: "policy reason",
			role: "customer | provider",
			recipientDomain: "domain",
			recipientHash: "keyed hash of the address",
		},
	},
} as const satisfies Record<string, EventTypeDoc>;

export type EventType = keyof typeof EVENT_CATALOGUE;

export const isKnownEventType = (type: string): type is EventType =>
	Object.prototype.hasOwnProperty.call(EVENT_CATALOGUE, type);
