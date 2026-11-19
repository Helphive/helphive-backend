// Derives historical business events from stored records, for scripts/backfill-events.ts. Pure: takes plain objects
// (as .lean() returns them) and returns event documents. Each derived event has a deterministic key
// ("backfill:<type>:<record id>"), so running the backfill twice writes nothing new.
//
// Only stored timestamps are used. Where a record has no timestamp for a step (bookings accepted before acceptedAt
// existed, emails verified before events existed) no event is derived. Where the only time available is a record's
// updatedAt, the event carries properties.approximateTime = true.
import { buildEvent, type EventInput } from "./events";
import { EXPIRED_CANCELLATION_REASON } from "../controllers/user-controllers/utils/booking.utils";
import type { EventType } from "./eventCatalogue";

type Id = { toString(): string } | string | null | undefined;

const validDate = (value: unknown): Date | null => {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value as string);
	return Number.isNaN(date.getTime()) ? null : date;
};

const str = (value: Id) => (value ? String(value) : undefined);

export type BackfillEvent = ReturnType<typeof buildEvent>;

const derived = (
	type: EventType,
	sourceId: Id,
	at: unknown,
	input: Omit<EventInput, "type" | "at" | "key" | "source">,
	keySuffix = "",
): BackfillEvent | null => {
	const when = validDate(at);
	if (!when || !sourceId) return null;
	return buildEvent(
		{ ...input, type, at: when, key: `backfill:${type}:${String(sourceId)}${keySuffix}`, source: "backfill" },
		undefined,
	);
};

const compact = (events: (BackfillEvent | null)[]) => events.filter((event): event is BackfillEvent => event !== null);

export const deriveUserEvents = (user: any): BackfillEvent[] => {
	const provider = !!user?.roles?.Provider;
	return compact([
		derived("user.signed_up", user?._id, user?.createdAt, {
			actor: { type: provider ? "provider" : "user", id: str(user?._id) },
			subjects: { userId: user?._id, ...(provider ? { providerId: user?._id } : {}) },
			properties: { role: provider ? "provider" : "customer" },
		}),
	]);
};

/** `providerIdByApplication` maps an application id to the user who submitted it (users.providerApplications). */
export const deriveApplicationEvents = (
	application: any,
	providerIdByApplication: Map<string, string>,
): BackfillEvent[] => {
	const providerId = providerIdByApplication.get(String(application?._id));
	const subjects = { applicationId: application?._id, providerId, userId: providerId };
	const decided = application?.status === "approved" || application?.status === "rejected";
	const reviewedAt = application?.reviewedAt ?? (decided ? application?.updatedAt : null);
	const submitted = validDate(application?.createdAt);
	const reviewed = validDate(reviewedAt);
	return compact([
		derived("provider.application_submitted", application?._id, application?.createdAt, {
			actor: { type: "provider", id: providerId },
			subjects,
			properties: { jobTypes: application?.jobTypes ?? null },
		}),
		decided
			? derived("provider.application_reviewed", application?._id, reviewedAt, {
					actor: { type: "admin", id: str(application?.reviewedBy) },
					subjects,
					properties: {
						decision: application.status,
						...(application.status === "rejected" && application.rejectReason
							? { reason: application.rejectReason }
							: {}),
						waitedMs: submitted && reviewed ? reviewed.getTime() - submitted.getTime() : null,
						...(application?.reviewedAt ? {} : { approximateTime: true }),
					},
				})
			: null,
	]);
};

const isExpired = (booking: any) =>
	booking.cancellationReason === EXPIRED_CANCELLATION_REASON ||
	(!booking.cancellationReason &&
		!booking.providerId &&
		booking.cancelledAt &&
		new Date(booking.cancelledAt).getTime() >= new Date(booking.startDate).getTime());

export const deriveBookingEvents = (booking: any): BackfillEvent[] => {
	const subjects = { userId: booking?.userId, providerId: booking?.providerId ?? undefined, bookingId: booking?._id };
	const customer = { type: "user" as const, id: str(booking?.userId) };
	const provider = { type: "provider" as const, id: str(booking?.providerId) };
	const startDate = validDate(booking?.startDate);
	const created = validDate(booking?.createdAt);
	const offset = (at: unknown) => {
		const when = validDate(at);
		return when && startDate ? when.getTime() - startDate.getTime() : null;
	};
	const byWhom = (id: Id) => (id && String(id) === String(booking?.userId) ? "customer" : "provider");
	const events = [
		derived("booking.created", booking?._id, booking?.createdAt, {
			actor: customer,
			subjects: { userId: booking?.userId, bookingId: booking?._id },
			properties: {
				serviceId: booking?.service?.id ?? null,
				rate: booking?.rate ?? null,
				hours: booking?.hours ?? null,
				amount:
					typeof booking?.rate === "number" && typeof booking?.hours === "number"
						? booking.rate * booking.hours
						: null,
				startDate: startDate,
				leadTimeMs: startDate && created ? startDate.getTime() - created.getTime() : null,
			},
		}),
		booking?.acceptedAt
			? derived("booking.accepted", booking._id, booking.acceptedAt, {
					actor: provider,
					subjects,
					properties: {
						timeToAcceptMs: created
							? (validDate(booking.acceptedAt)?.getTime() ?? 0) - created.getTime()
							: null,
						untilStartMs: startDate
							? startDate.getTime() - (validDate(booking.acceptedAt)?.getTime() ?? 0)
							: null,
					},
				})
			: null,
		booking?.startRequestedAt
			? derived("booking.start_requested", booking._id, booking.startRequestedAt, {
					actor: provider,
					subjects,
					properties: { offsetFromStartMs: offset(booking.startRequestedAt) },
				})
			: null,
		booking?.startedAt
			? derived("booking.start_approved", booking._id, booking.startedAt, {
					actor: customer,
					subjects,
					properties: {
						approvalWaitMs: booking.startRequestedAt
							? (validDate(booking.startedAt)?.getTime() ?? 0) -
								(validDate(booking.startRequestedAt)?.getTime() ?? 0)
							: null,
					},
				})
			: null,
		booking?.startedAt
			? derived("booking.started", booking._id, booking.startedAt, {
					actor: customer,
					subjects,
					properties: { offsetFromStartMs: offset(booking.startedAt) },
				})
			: null,
		booking?.status === "completed"
			? derived("booking.completed", booking._id, booking.completedAt, {
					actor: byWhom(booking.completedBy) === "customer" ? customer : provider,
					subjects,
					properties: {
						by: booking.completedBy ? byWhom(booking.completedBy) : null,
						durationMs:
							booking.startedAt && booking.completedAt
								? (validDate(booking.completedAt)?.getTime() ?? 0) -
									(validDate(booking.startedAt)?.getTime() ?? 0)
								: null,
						bookedHours: booking.hours ?? null,
					},
				})
			: null,
		booking?.status === "cancelled" && isExpired(booking)
			? derived("booking.expired", booking._id, booking.cancelledAt, {
					actor: { type: "system" },
					subjects: { userId: booking.userId, bookingId: booking._id },
				})
			: null,
		booking?.status === "cancelled" && !isExpired(booking)
			? derived("booking.cancelled", booking._id, booking.cancelledAt, {
					actor: byWhom(booking.cancelledBy) === "customer" ? customer : provider,
					subjects,
					properties: {
						by: booking.cancelledBy ? byWhom(booking.cancelledBy) : null,
						reason: booking.cancellationReason ?? null,
						wasAccepted: !!booking.providerId,
					},
				})
			: null,
	];
	return compact(events);
};

/** `bookingUserId` is the customer of the payment's booking, when known. */
export const derivePaymentEvents = (payment: any, bookingUserId?: Id): BackfillEvent[] => {
	const subjects = { userId: bookingUserId ?? undefined, bookingId: payment?.bookingId, paymentId: payment?._id };
	const paid = payment?.status === "completed";
	const paidAt = payment?.paidAt ?? (paid ? payment?.updatedAt : null);
	const approximate = payment?.paidAt ? {} : { approximateTime: true };
	const hasRefund = typeof payment?.refundId === "string" && payment.refundId.length > 0;
	const refundOutcome = hasRefund ? payment.refundStatus : null;
	return compact([
		paid
			? derived("payment.succeeded", payment._id, paidAt, {
					actor: { type: "system" },
					subjects,
					properties: { amount: payment.amount, ...approximate },
				})
			: null,
		paid
			? derived("booking.paid", payment._id, paidAt, {
					actor: { type: "system" },
					subjects,
					properties: { amount: payment.amount, ...approximate },
				})
			: null,
		hasRefund
			? derived("refund.created", payment._id, payment.refundCreated, {
					actor: { type: "system" },
					subjects: { bookingId: payment.bookingId, paymentId: payment._id },
					properties: { amount: payment.refundAmount ?? null },
				})
			: null,
		refundOutcome === "succeeded"
			? derived("refund.succeeded", payment._id, payment.updatedAt, {
					actor: { type: "system" },
					subjects: { bookingId: payment.bookingId, paymentId: payment._id },
					properties: { amount: payment.refundAmount ?? null, approximateTime: true },
				})
			: null,
		refundOutcome === "failed" || refundOutcome === "cancelled"
			? derived("refund.failed", payment._id, payment.updatedAt, {
					actor: { type: "system" },
					subjects: { bookingId: payment.bookingId, paymentId: payment._id },
					properties: { status: refundOutcome, amount: payment.refundAmount ?? null, approximateTime: true },
				})
			: null,
	]);
};

/** `providerId` is the provider of the earning's booking, when known. */
export const deriveEarningEvents = (earning: any, providerId?: Id): BackfillEvent[] => {
	const subjects = { providerId: providerId ?? undefined, bookingId: earning?.bookingId, earningId: earning?._id };
	const created = validDate(earning?.date ?? earning?.createdAt);
	const released = validDate(earning?.completionDate);
	return compact([
		derived("earning.created", earning?._id, created, {
			actor: { type: "system" },
			subjects,
			properties: { amount: earning?.amount ?? null },
		}),
		earning?.status === "completed"
			? derived("earning.released", earning._id, released, {
					actor: { type: "system" },
					subjects,
					properties: {
						amount: earning.amount ?? null,
						waitedMs: created && released ? released.getTime() - created.getTime() : null,
					},
				})
			: null,
	]);
};

export const derivePayoutEvents = (payout: any): BackfillEvent[] => {
	const subjects = { providerId: payout?.userId, payoutId: payout?._id };
	const finalAt = (field: "paidAt" | "failedAt") => payout?.[field] ?? payout?.updatedAt;
	const approximate = (field: "paidAt" | "failedAt") => (payout?.[field] ? {} : { approximateTime: true });
	return compact([
		derived("payout.requested", payout?._id, payout?.createdAt, {
			actor: { type: "provider", id: str(payout?.userId) },
			subjects,
			properties: { amount: payout?.amount ?? null },
		}),
		payout?.status === "paid"
			? derived("payout.paid", payout._id, finalAt("paidAt"), {
					actor: { type: "system" },
					subjects,
					properties: { amount: payout.amount ?? null, ...approximate("paidAt") },
				})
			: null,
		payout?.status === "failed" || payout?.status === "cancelled"
			? derived("payout.failed", payout._id, finalAt("failedAt"), {
					actor: { type: "system" },
					subjects,
					properties: { status: payout.status, amount: payout.amount ?? null, ...approximate("failedAt") },
				})
			: null,
	]);
};

/** Events strictly before `until` (live recording covers the rest). */
export const before = (events: BackfillEvent[], until: Date | null) =>
	until ? events.filter((event) => (event.at as Date).getTime() < until.getTime()) : events;

export const countByType = (events: BackfillEvent[], counts: Map<string, number> = new Map()) => {
	for (const event of events) counts.set(event.type as string, (counts.get(event.type as string) ?? 0) + 1);
	return counts;
};
