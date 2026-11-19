// Card disputes for the console: list and detail, with the booking's timeline and both parties as the evidence to
// hand, and a link to respond in Stripe. Read only: evidence is submitted in the Stripe dashboard.
import type { Request, Response } from "express";
import DisputeModel from "../../dal/models/dispute.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import { parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import { DISPUTE_REASONS, DISPUTE_STATUSES, NEEDS_RESPONSE, responseDeadline } from "../../lib/disputes";
import { roundMoney } from "../../lib/operations";
import { DETAIL_TIME_LIMIT_MS, answerError, eventsFor, loadPeople, notesFor } from "./operations.shared";
import { adminPayment } from "./payments.controller";
import { bookingCore } from "./bookings.controller";
import { stripeModeOf } from "../../lib/settings";

const stripeMode = () => stripeModeOf(process.env.STRIPE_SECRET_KEY);

export const DISPUTE_LIST_SPEC: ListSpec = {
	sortable: { openedAt: "openedAt", evidenceDueBy: "evidenceDueBy", amount: "amount" },
	defaultSort: "-openedAt",
	filters: {
		status: { type: "enum", path: "status", values: DISPUTE_STATUSES },
		reason: { type: "enum", path: "reason", values: Object.keys(DISPUTE_REASONS) },
		outcome: { type: "enum", path: "outcome", values: ["won", "lost", "warning_closed"] },
		bookingId: { type: "objectId", path: "bookingId" },
		paymentId: { type: "objectId", path: "paymentId" },
		open: {
			type: "custom",
			parse: (value) =>
				value === "true" ? { closedAt: null } : value === "false" ? { closedAt: { $ne: null } } : null,
		},
		needsResponse: {
			type: "custom",
			parse: (value) =>
				value === "true"
					? { status: { $in: [...NEEDS_RESPONSE] } }
					: value === "false"
						? { status: { $nin: [...NEEDS_RESPONSE] } }
						: null,
		},
	},
	dateField: "openedAt",
	maxPageSize: 100,
};

export const stripeDisputeUrl = (disputeId: string) =>
	`https://dashboard.stripe.com${stripeMode() === "test" ? "/test" : ""}/disputes/${encodeURIComponent(disputeId)}`;

export const publicDispute = (d: any, now = new Date()) => ({
	_id: String(d._id),
	disputeId: d.disputeId,
	chargeId: d.chargeId ?? null,
	paymentIntentId: d.paymentIntentId ?? null,
	paymentId: d.paymentId ? String(d.paymentId) : null,
	bookingId: d.bookingId ? String(d.bookingId) : null,
	userId: d.userId ? String(d.userId) : null,
	providerId: d.providerId ? String(d.providerId) : null,
	amount: roundMoney(d.amount),
	currency: d.currency,
	reason: d.reason,
	reasonLabel: DISPUTE_REASONS[d.reason] ?? d.reason,
	status: d.status,
	needsResponse: NEEDS_RESPONSE.has(d.status),
	evidenceDueBy: d.evidenceDueBy ?? null,
	deadline: responseDeadline(
		{ status: d.status, evidenceDueBy: d.evidenceDueBy ? new Date(d.evidenceDueBy) : null },
		now,
	),
	isChargeRefundable: !!d.isChargeRefundable,
	livemode: !!d.livemode,
	openedAt: d.openedAt,
	fundsWithdrawnAt: d.fundsWithdrawnAt ?? null,
	fundsReinstatedAt: d.fundsReinstatedAt ?? null,
	closedAt: d.closedAt ?? null,
	outcome: d.outcome ?? null,
	stripeUrl: stripeDisputeUrl(d.disputeId),
});

/** GET /admin/disputes */
export const handleListDisputes = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query as Record<string, unknown>, DISPUTE_LIST_SPEC);
		const page = await runListQuery(DisputeModel, parsed);
		const people = await loadPeople(page.items.flatMap((d: any) => [d.userId, d.providerId]));
		const now = new Date();
		const [openCount, needsResponseCount] = await Promise.all([
			DisputeModel.countDocuments({ closedAt: null }).maxTimeMS(DETAIL_TIME_LIMIT_MS).exec(),
			DisputeModel.countDocuments({ status: { $in: [...NEEDS_RESPONSE] } })
				.maxTimeMS(DETAIL_TIME_LIMIT_MS)
				.exec(),
		]);
		res.json({
			...page,
			items: page.items.map((d: any) => ({
				...publicDispute(d, now),
				customer: d.userId ? (people.get(String(d.userId)) ?? null) : null,
				provider: d.providerId ? (people.get(String(d.providerId)) ?? null) : null,
			})),
			counts: { open: openCount, needsResponse: needsResponseCount },
		});
	} catch (error) {
		answerError(res, error, "listing disputes");
	}
};

/** GET /admin/disputes/:id (our id or Stripe's dp_ id) */
export const handleGetDispute = async (req: Request, res: Response) => {
	try {
		const id = req.params.id;
		const dispute: any = await DisputeModel.findOne(/^[a-f\d]{24}$/i.test(id) ? { _id: id } : { disputeId: id })
			.maxTimeMS(DETAIL_TIME_LIMIT_MS)
			.lean()
			.exec();
		if (!dispute) return res.status(404).json({ message: "Dispute not found." });
		const [booking, payment, earnings, people] = await Promise.all([
			dispute.bookingId
				? BookingModel.findById(dispute.bookingId).maxTimeMS(DETAIL_TIME_LIMIT_MS).lean().exec()
				: null,
			dispute.paymentId
				? PaymentModel.findById(dispute.paymentId).maxTimeMS(DETAIL_TIME_LIMIT_MS).lean().exec()
				: null,
			dispute.bookingId ? EarningModel.find({ bookingId: dispute.bookingId }).lean().exec() : [],
			loadPeople([dispute.userId, dispute.providerId]),
		]);
		const [events, notes] = await Promise.all([
			dispute.bookingId ? eventsFor({ bookingId: dispute.bookingId }, 100) : [],
			dispute.bookingId ? notesFor("booking", dispute.bookingId) : [],
		]);
		const b: any = booking;
		const lifecycle = b
			? (
					[
						["created", b.createdAt],
						["accepted", b.acceptedAt],
						["start_requested", b.startRequestedAt],
						["started", b.startedAt],
						["completed", b.completedAt],
						["cancelled", b.cancelledAt],
					] as [string, Date | undefined][]
				)
					.filter(([, at]) => at)
					.map(([step, at]) => ({ source: "booking", step, at }))
			: [];
		const timeline = [
			...lifecycle,
			...events.map((event) => ({ source: "event", step: event.type, at: event.at, event })),
			...(dispute.history ?? []).map((h: any) => ({
				source: "dispute",
				step: h.type,
				at: h.at,
				status: h.status,
			})),
		].sort((x: any, y: any) => new Date(x.at).getTime() - new Date(y.at).getTime());
		res.json({
			dispute: publicDispute(dispute),
			history: dispute.history ?? [],
			booking: b ? bookingCore(b) : null,
			payment: payment ? adminPayment(payment) : null,
			earnings: earnings.map((e: any) => ({
				_id: String(e._id),
				amount: roundMoney(e.amount),
				status: e.status,
				createdAt: e.createdAt,
				releasedAt: e.completionDate ?? null,
			})),
			customer: dispute.userId ? (people.get(String(dispute.userId)) ?? null) : null,
			provider: dispute.providerId ? (people.get(String(dispute.providerId)) ?? null) : null,
			timeline,
			notes,
			guidance: evidenceGuidance(dispute.reason),
		});
	} catch (error) {
		answerError(res, error, "getting dispute");
	}
};

/** What to gather for the most common reasons, shown beside the deadline. */
export const evidenceGuidance = (reason: string) => {
	const common = [
		"Booking reference, service, date and hours booked",
		"The provider's start request and the customer's start approval times",
		"Completion time and who completed it",
	];
	switch (reason) {
		case "fraudulent":
		case "unrecognized":
			return [
				...common,
				"The customer's account age and previous completed bookings",
				"That the customer approved the start in the app",
			];
		case "product_not_received":
			return [...common, "The provider's arrival and in-progress timeline", "Messages or notes from the day"];
		case "product_unacceptable":
			return [...common, "Any complaint received and how it was handled", "Refunds already made"];
		case "duplicate":
			return [...common, "Each charge and what it was for (one payment per booking)"];
		case "credit_not_processed":
			return [...common, "Refunds made, with Stripe refund ids and dates", "The cancellation terms"];
		default:
			return common;
	}
};
