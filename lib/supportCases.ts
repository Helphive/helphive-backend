// Support cases, the pure part: categories, statuses and which changes are allowed, the parties of a case, and the
// case reference. Cases are opened by admins today; `source` and `openedBy` already allow customers and providers to
// open them from the apps later (openedBy.type "user", source "customer" | "provider").

export const CASE_CATEGORIES = [
	"booking",
	"payment",
	"refund",
	"dispute",
	"account",
	"provider_conduct",
	"customer_conduct",
	"safety",
	"technical",
	"other",
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export const CASE_STATUSES = ["open", "waiting_on_customer", "waiting_on_provider", "resolved", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const CASE_SOURCES = ["admin", "customer", "provider", "email"] as const;

export const CASE_OUTCOMES = ["resolved", "refunded", "no_action", "duplicate", "escalated", "other"] as const;

export const CASE_ACTION_TYPES = [
	"refund",
	"booking_cancelled",
	"booking_released",
	"booking_resolved",
	"user_suspended",
	"user_reinstated",
	"other",
] as const;

/** Open statuses; resolved and closed are done. */
export const OPEN_STATUSES: ReadonlySet<string> = new Set(["open", "waiting_on_customer", "waiting_on_provider"]);

/**
 * Whether a case may move from `from` to `to` through PATCH. Resolving goes through the resolve action (it needs an
 * outcome); a resolved case can be closed or reopened; a closed case can only be reopened.
 */
export const canChangeStatus = (from: string, to: string): { ok: true } | { ok: false; message: string } => {
	if (from === to) return { ok: false, message: `The case is already ${to.replace(/_/g, " ")}.` };
	if (to === "resolved") return { ok: false, message: "Resolve the case with an outcome (POST .../resolve)." };
	if (from === "closed" && to !== "open") return { ok: false, message: "A closed case can only be reopened." };
	if (to === "closed" && from !== "resolved") return { ok: false, message: "Resolve the case before closing it." };
	return { ok: true };
};

/** "CS-1A2B3C": a short reference from the case id, for emails and the console. */
export const caseReference = (id: unknown) => `CS-${String(id).slice(-6).toUpperCase()}`;

export interface PartySource {
	booking?: { userId?: unknown; providerId?: unknown } | null;
	/** A user the case is about directly (role from the account). */
	user?: { _id: unknown; roles?: { Provider?: boolean } | null } | null;
}

/** The customer and provider of a case: from its booking when there is one, else the user it is about. */
export const partiesOf = (source: PartySource) => {
	const parties: { role: "customer" | "provider"; userId: string }[] = [];
	const add = (role: "customer" | "provider", id: unknown) => {
		if (!id) return;
		const userId = String(id);
		if (!parties.some((p) => p.userId === userId && p.role === role)) parties.push({ role, userId });
	};
	if (source.booking) {
		add("customer", source.booking.userId);
		add("provider", source.booking.providerId);
	}
	if (source.user) add(source.user.roles?.Provider ? "provider" : "customer", source.user._id);
	return parties;
};

/** Email subject for a case message: the admin's subject with the reference, so replies can be matched later. */
export const caseMessageSubject = (reference: string, subject: string) =>
	subject.includes(reference) ? subject : `${subject} [${reference}]`;
