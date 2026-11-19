// Bookings for the operations console: list and detail (bookings.read), and the actions (bookings.manage): cancel for
// a party, release back to open, and resolve a stuck in-progress booking. Every action reuses the apps' own
// transitions (utils/bookingActions.utils.ts) and refund path (refundPaymentIfPaid); none moves money another way.
import { Request, Response } from "express";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import NotificationModel from "../../dal/models/notification.model";
import TaskRunModel from "../../dal/models/taskRun.model";
import { parseDateBound, parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import { bookingSearchQueries, buildSearchPlan, isSearchable } from "../../lib/adminSearch";
import {
	PROVIDER_SHARE,
	amountBoundFilter,
	bookingReference,
	displayStatusFilter,
	formatDuration,
	planRefund,
	refundTotals,
	roundMoney,
	fromCents,
} from "../../lib/operations";
import { bookingDisplayAddress, getBookingDisplayStatus } from "../user-controllers/utils/booking.utils";
import { syncChatPair } from "../../lib/chat/chatSync";
import { hasRefund } from "../user-controllers/utils/payment.utils";
import { refundPaymentIfPaid, type RefundIfPaidResult } from "../user-controllers/utils/auth.utils";
import { cancelBookingTransition, completeBookingTransition } from "../user-controllers/utils/bookingActions.utils";
import { sendBookingNotification } from "../webhook-controllers/stripe.controller";
import { sendNotification, storeNotification } from "../service-accounts/onesignal";
import { describeBooking } from "../user-controllers/utils/booking.utils";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import log from "../../lib/logger";
import {
	DETAIL_TIME_LIMIT_MS,
	answerError,
	auditFor,
	enumParam,
	eventsFor,
	loadPeople,
	notesFor,
	runSearch,
	takeParams,
} from "./operations.shared";
import { searchUserIds } from "./users.controller";
import { adminPayment } from "./payments.controller";

const HOUR = 60 * 60 * 1000;
const SEARCH_MATCH_LIMIT = 200;

const dateFilter = (path: string, name: string, end: boolean) => ({
	type: "custom" as const,
	parse: (value: string) => ({ [path]: { [end ? "$lt" : "$gte"]: parseDateBound(value, name, end) } }),
});

const amountFilter = (op: "$gte" | "$lte") => ({
	type: "custom" as const,
	parse: (value: string) => {
		if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return null;
		return amountBoundFilter(op, Number(value));
	},
});

export const BOOKING_LIST_SPEC: ListSpec = {
	sortable: {
		createdAt: "createdAt",
		startDate: "startDate",
		completedAt: "completedAt",
		cancelledAt: "cancelledAt",
	},
	defaultSort: "-createdAt",
	filters: {
		status: { type: "enum", path: "status", values: ["pending", "in progress", "completed", "cancelled"] },
		displayStatus: { type: "custom", parse: (value) => displayStatusFilter(value, new Date()) },
		service: {
			type: "custom",
			parse: (value) => (["1", "2", "3"].includes(value) ? { "service.id": Number(value) } : null),
		},
		hasProvider: {
			type: "custom",
			parse: (value) =>
				value === "true" ? { providerId: { $ne: null } } : value === "false" ? { providerId: null } : null,
		},
		customerId: { type: "objectId", path: "userId" },
		providerId: { type: "objectId", path: "providerId" },
		startFrom: dateFilter("startDate", "startFrom", false),
		startTo: dateFilter("startDate", "startTo", true),
		completedFrom: dateFilter("completedAt", "completedFrom", false),
		completedTo: dateFilter("completedAt", "completedTo", true),
		amountMin: amountFilter("$gte"),
		amountMax: amountFilter("$lte"),
	},
	dateField: "createdAt",
	maxPageSize: 100,
};

export const PAYMENT_STATES = ["unpaid", "pending", "paid", "cancelled"] as const;
export const REFUND_STATES = ["none", "any", "pending", "succeeded", "failed", "cancelled"] as const;

/** Booking ids by the state of their payment (paid, refunded...), for list filters that need the payments. */
const bookingIdsByPayment = async (paymentState?: string, refundState?: string) => {
	const clauses: Record<string, unknown>[] = [];
	if (paymentState) {
		if (paymentState === "unpaid") {
			const paid = await PaymentModel.distinct("bookingId", { status: "completed" })
				.maxTimeMS(DETAIL_TIME_LIMIT_MS)
				.exec();
			clauses.push({ _id: { $nin: paid } });
		} else {
			const status = paymentState === "paid" ? "completed" : paymentState;
			const ids = await PaymentModel.distinct("bookingId", { status }).maxTimeMS(DETAIL_TIME_LIMIT_MS).exec();
			clauses.push({ _id: { $in: ids } });
		}
	}
	if (refundState) {
		const refunded = { refundId: { $type: "string" } };
		const filter = ["none", "any"].includes(refundState) ? refunded : { ...refunded, refundStatus: refundState };
		const ids = await PaymentModel.distinct("bookingId", filter).maxTimeMS(DETAIL_TIME_LIMIT_MS).exec();
		clauses.push({ _id: refundState === "none" ? { $nin: ids } : { $in: ids } });
	}
	return clauses;
};

/** A filter for the bookings a search matches: their own fields, or the customer's or provider's. */
const bookingSearchFilter = async (q: string | undefined) => {
	if (q === undefined) return null;
	const plan = buildSearchPlan(q);
	if (!isSearchable(plan) && plan.text.length < 3) return { _id: { $in: [] } };
	const [own, people] = await Promise.all([
		runSearch<{ _id: unknown }>(BookingModel, bookingSearchQueries(plan, { addressPrefix: true }), {
			limit: SEARCH_MATCH_LIMIT,
			projection: "_id",
		}),
		isSearchable(plan) ? searchUserIds(q) : Promise.resolve([]),
	]);
	const or: Record<string, unknown>[] = [{ _id: { $in: own.map((b) => b._id) } }];
	if (people?.length) or.push({ userId: { $in: people } }, { providerId: { $in: people } });
	return { $or: or };
};

/** Payment summary of a booking for lists (latest payment). */
const paymentSummary = (payment: any) =>
	payment
		? {
				_id: String(payment._id),
				status: payment.status,
				amount: roundMoney(payment.amount),
				paidAt: payment.paidAt ?? (payment.status === "completed" ? payment.date : null),
				refundStatus: hasRefund(payment) ? payment.refundStatus : null,
				refundAmount: hasRefund(payment) ? roundMoney(payment.refundAmount ?? 0) : 0,
			}
		: null;

export const bookingCore = (booking: any) => ({
	_id: String(booking._id),
	reference: bookingReference(booking._id),
	status: booking.status,
	displayStatus: getBookingDisplayStatus(booking),
	service: booking.service,
	rate: booking.rate,
	hours: booking.hours,
	amount: roundMoney(booking.rate * booking.hours),
	startDate: booking.startDate,
	scheduledEnd: new Date(new Date(booking.startDate).getTime() + Number(booking.hours || 0) * HOUR),
	address: bookingDisplayAddress(booking),
	latitude: booking.latitude,
	longitude: booking.longitude,
	// Picker details (null on older bookings): Google's address, place name, how it was chosen, and custom text.
	location: booking.location ?? null,
	customerId: booking.userId ? String(booking.userId) : null,
	providerId: booking.providerId ? String(booking.providerId) : null,
	createdAt: booking.createdAt,
	acceptedAt: booking.acceptedAt ?? null,
	startRequestedAt: booking.startRequestedAt ?? null,
	startedAt: booking.startedAt ?? null,
	completedAt: booking.completedAt ?? null,
	cancelledAt: booking.cancelledAt ?? null,
	cancelledBy: booking.cancelledBy ? String(booking.cancelledBy) : null,
	cancellationReason: booking.cancellationReason ?? null,
	userApprovalRequested: !!booking.userApprovalRequested,
});

/** GET /admin/bookings */
export const handleListBookings = async (req: Request, res: Response) => {
	try {
		const { rest, values } = takeParams(req.query as Record<string, unknown>, ["q", "paymentState", "refundState"]);
		const parsed = parseListQuery(rest, BOOKING_LIST_SPEC);
		const paymentState = enumParam(values.paymentState, "paymentState", PAYMENT_STATES);
		const refundState = enumParam(values.refundState, "refundState", REFUND_STATES);
		const clauses = await bookingIdsByPayment(paymentState, refundState);
		const search = await bookingSearchFilter(values.q);
		if (search) clauses.push(search);

		const page = await runListQuery(BookingModel, parsed, {
			baseFilter: clauses.length ? { $and: clauses } : undefined,
		});
		const ids = page.items.map((b: any) => b._id);
		const [people, payments] = await Promise.all([
			loadPeople(page.items.flatMap((b: any) => [b.userId, b.providerId])),
			PaymentModel.find({ bookingId: { $in: ids } })
				.sort({ createdAt: 1 })
				.lean()
				.exec(),
		]);
		const paymentByBooking = new Map(payments.map((p) => [String(p.bookingId), p]));
		res.json({
			...page,
			items: page.items.map((booking: any) => ({
				...bookingCore(booking),
				customer: people.get(String(booking.userId)) ?? null,
				provider: booking.providerId ? (people.get(String(booking.providerId)) ?? null) : null,
				payment: paymentSummary(paymentByBooking.get(String(booking._id))),
			})),
		});
	} catch (error) {
		answerError(res, error, "listing bookings");
	}
};

/** Lifecycle timestamps as timeline entries, merged with the event stream below. */
const lifecycle = (booking: any) =>
	[
		["created", booking.createdAt],
		["accepted", booking.acceptedAt],
		["start_requested", booking.startRequestedAt],
		["started", booking.startedAt],
		["completed", booking.completedAt],
		["cancelled", booking.cancelledAt],
	]
		.filter(([, at]) => at)
		.map(([step, at]) => ({ source: "booking", step, at }));

/** GET /admin/bookings/:id */
export const handleGetBooking = async (req: Request, res: Response) => {
	try {
		const booking: any = await BookingModel.findById(req.params.id).maxTimeMS(DETAIL_TIME_LIMIT_MS).lean().exec();
		if (!booking) return res.status(404).json({ message: "Booking not found." });
		const [people, payments, earnings, notifications, events, taskRuns, notes, audit] = await Promise.all([
			loadPeople([booking.userId, booking.providerId]),
			PaymentModel.find({ bookingId: booking._id }).sort({ createdAt: 1 }).lean().exec(),
			EarningModel.find({ bookingId: booking._id }).lean().exec(),
			NotificationModel.find({ bookingId: booking._id }, "title type userId screen read createdAt")
				.sort({ createdAt: 1 })
				.limit(100)
				.lean()
				.exec(),
			eventsFor({ bookingId: booking._id }, 100),
			TaskRunModel.find({ bookingId: String(booking._id) })
				.sort({ receivedAt: -1 })
				.limit(20)
				.lean()
				.exec(),
			notesFor("booking", booking._id),
			auditFor(req, "booking", booking._id),
		]);
		const customerId = String(booking.userId);
		const timeline = [
			...lifecycle(booking),
			...events.map((event) => ({ source: "event", step: event.type, at: event.at, event })),
		].sort((a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime());
		res.json({
			booking: bookingCore(booking),
			customer: people.get(customerId) ?? null,
			provider: booking.providerId ? (people.get(String(booking.providerId)) ?? null) : null,
			payments: payments.map(adminPayment),
			earnings: earnings.map((earning: any) => ({
				_id: String(earning._id),
				amount: roundMoney(earning.amount),
				status: earning.status,
				createdAt: earning.createdAt,
				releasedAt: earning.completionDate ?? null,
				transferId: earning.transferId ?? null,
			})),
			notifications: notifications.map((n: any) => ({
				_id: String(n._id),
				title: n.title,
				type: n.type,
				recipient: n.userId === customerId ? "customer" : "provider",
				recipientId: n.userId,
				read: n.read,
				createdAt: n.createdAt,
			})),
			taskRuns: taskRuns.map((run: any) => ({
				_id: String(run._id),
				task: run.task,
				outcome: run.outcome,
				status: run.status,
				receivedAt: run.receivedAt,
				note: run.note ?? null,
				error: run.error ?? null,
			})),
			timeline,
			notes,
			audit,
		});
	} catch (error) {
		answerError(res, error, "getting booking");
	}
};

// --- Actions ---------------------------------------------------------------------------------------------------

const bookingTarget = (id: unknown) => ({ type: "booking", id: String(id) });

/** What happened to the money after a cancellation, in words the console can show. */
const describeRefund = async (result: RefundIfPaidResult | { outcome: "error"; message: string }) => {
	if (result.outcome === "refund_requested") {
		return {
			outcome: result.outcome,
			amount: roundMoney(result.amount),
			refundId: result.refundId,
			explanation: `A full refund of $${result.amount.toFixed(2)} was requested from Stripe. The customer is notified when Stripe confirms it.`,
		};
	}
	if (result.outcome === "already_refunded" && result.paymentId) {
		const payment = await PaymentModel.findById(result.paymentId).lean().exec();
		const totals = payment ? refundTotals(payment as any) : null;
		return {
			outcome: result.outcome,
			amount: 0,
			remainingRefundable: totals ? fromCents(totals.remainingCents) : null,
			explanation:
				"The payment already had a refund, so nothing more was refunded automatically. Refund any remainder from the payment.",
		};
	}
	if (result.outcome === "error") {
		return {
			outcome: "error",
			amount: 0,
			explanation: `The booking is cancelled but the refund could not be started (${result.message}). Refund it from the payment.`,
		};
	}
	return {
		outcome: result.outcome,
		amount: 0,
		explanation:
			result.outcome === "not_paid" || result.outcome === "no_payment"
				? "The booking was not paid, so there was nothing to refund."
				: "Nothing was refunded.",
	};
};

const safeRefund = async (bookingId: string) => {
	try {
		return await refundPaymentIfPaid(bookingId);
	} catch (error: any) {
		log.error(`Refund after admin cancellation of ${bookingId} failed`, error);
		return {
			outcome: "error" as const,
			message: error?.message ? String(error.message).slice(0, 200) : "Stripe error",
		};
	}
};

/**
 * POST /admin/bookings/:id/cancel { onBehalfOf: "customer" | "provider", reason }. The app rule: only a booking that
 * has not started (status pending) can be cancelled, and a paid one is refunded in full unless it already has a refund.
 */
export const handleCancelBookingForParty = async (req: Request, res: Response) => {
	try {
		const booking = await BookingModel.findById(req.params.id).exec();
		if (!booking) return res.status(404).json({ message: "Booking not found." });
		const onBehalfOf = req.body.onBehalfOf as "customer" | "provider";
		if (booking.status !== "pending") {
			return res.status(409).json({
				message:
					booking.status === "in progress"
						? "This booking has started. Use resolve to cancel a stuck booking in progress."
						: `This booking is already ${booking.status}.`,
			});
		}
		if (onBehalfOf === "provider" && !booking.providerId) {
			return res.status(409).json({ message: "No provider has accepted this booking." });
		}
		const party = onBehalfOf === "customer" ? booking.userId : booking.providerId!;
		const before = { status: booking.status, displayStatus: getBookingDisplayStatus(booking) };
		const cancelled = await cancelBookingTransition({
			bookingId: booking._id as any,
			cancelledBy: party,
			by: "admin",
			actor: { type: "admin", id: req.admin!._id },
			properties: { onBehalfOf },
			req,
		});
		if (!cancelled) return res.status(409).json({ message: "This booking changed meanwhile. Reload it." });
		const refund = await describeRefund(await safeRefund(String(cancelled._id)));
		await recordAudit(
			{
				action: "bookings.cancelled",
				actor: adminActor(req),
				target: bookingTarget(cancelled._id),
				before,
				after: {
					status: "cancelled",
					cancelledBy: onBehalfOf,
					refund: refund.outcome,
					refundAmount: refund.amount,
				},
				reason: String(req.body.reason),
				metadata: { onBehalfOf, refundId: (refund as any).refundId ?? null },
			},
			req,
		);
		res.json({ booking: bookingCore(cancelled.toObject()), refund });
	} catch (error) {
		answerError(res, error, "cancelling booking");
	}
};

const notifyRelease = async (booking: any, providerId: string) => {
	const bookingId = String(booking._id);
	const details = describeBooking(booking);
	const messages = [
		{
			id: String(booking.userId),
			screen: "BookingDetails",
			title: "Finding you a new provider",
			message: `Your provider can no longer do the ${details} booking. It is open again and we are finding you another provider.`,
		},
		{
			id: providerId,
			screen: "Home",
			title: "Removed from a booking",
			message: `You are no longer assigned to the ${details} booking. Contact support if you have questions.`,
		},
	];
	for (const { id, screen, title, message } of messages) {
		try {
			await sendNotification({
				include_aliases: { external_id: [id] },
				headings: { en: title },
				contents: { en: message },
				data: { screen, bookingId, type: "general" },
			});
			await storeNotification(title, message, id, screen, "general", bookingId);
		} catch (error) {
			log.error(`Error sending release notification for booking ${bookingId}`, error);
		}
	}
};

/**
 * POST /admin/bookings/:id/release { reason }: removes the provider from an accepted booking that has not started,
 * so another provider can accept it. Nearby available providers get the new-job alert again. No money moves.
 */
export const handleReleaseBooking = async (req: Request, res: Response) => {
	try {
		const booking = await BookingModel.findById(req.params.id).exec();
		if (!booking) return res.status(404).json({ message: "Booking not found." });
		if (booking.status !== "pending" || !booking.providerId) {
			return res.status(409).json({
				message:
					booking.status !== "pending"
						? `This booking is ${booking.status}; only an accepted booking that has not started can be released.`
						: "No provider has accepted this booking.",
			});
		}
		const now = new Date();
		if (booking.startDate.getTime() <= now.getTime()) {
			return res.status(409).json({
				message:
					"The start time has passed. No provider can accept it any more; cancel it instead (the customer is refunded).",
			});
		}
		const providerId = booking.providerId;
		const released = await BookingModel.findOneAndUpdate(
			{ _id: booking._id, status: "pending", providerId },
			{ $set: { providerId: null, acceptedAt: null, userApprovalRequested: false, startRequestedAt: null } },
			{ new: true },
		).exec();
		if (!released) return res.status(409).json({ message: "This booking changed meanwhile. Reload it." });

		emitEvent(
			{
				type: "booking.released",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { userId: released.userId, providerId, bookingId: released._id },
				properties: {
					untilStartMs: released.startDate.getTime() - now.getTime(),
					hadStartRequest: !!booking.userApprovalRequested,
				},
			},
			req,
		);
		await recordAudit(
			{
				action: "bookings.released",
				actor: adminActor(req),
				target: bookingTarget(released._id),
				before: { providerId: String(providerId), displayStatus: getBookingDisplayStatus(booking) },
				after: { providerId: null, displayStatus: getBookingDisplayStatus(released) },
				reason: String(req.body.reason),
			},
			req,
		);
		await notifyRelease(released, String(providerId));
		// The removed provider and the customer may no longer chat (unless another booking keeps it open).
		void syncChatPair(released.userId, providerId);
		// Providers only see paid jobs; tell nearby available ones, as when it was first paid.
		const paid = await PaymentModel.exists({ bookingId: released._id, status: "completed" });
		if (paid) await sendBookingNotification(released._id, released);
		res.json({
			booking: bookingCore(released.toObject()),
			removedProviderId: String(providerId),
			providersAlerted: !!paid,
		});
	} catch (error) {
		answerError(res, error, "releasing booking");
	}
};

/** What resolving an in-progress booking would do, for the confirmation and for the response. */
const resolutionPreview = (booking: any, payment: any, outcome: string, refund: string) => {
	const paid = payment && payment.status === "completed" ? roundMoney(payment.amount) : 0;
	const end = new Date(booking.startDate).getTime() + Number(booking.hours || 0) * HOUR;
	const overdue = Date.now() - end;
	const base = {
		outcome,
		paid,
		scheduledEnd: new Date(end),
		overdue: overdue > 0 ? formatDuration(overdue) : null,
	};
	if (outcome === "completed") {
		const earning = roundMoney(paid * PROVIDER_SHARE);
		return {
			...base,
			providerEarning: earning,
			platformFee: roundMoney(paid - earning),
			customerRefund: 0,
			explanation: `The booking becomes completed. The provider's earning of $${earning.toFixed(2)} is created and released to their Stripe account about 30 seconds later, as when a party completes it. The customer is not refunded.`,
		};
	}
	const plan = payment ? planRefund(payment, null) : null;
	const refundable = plan && plan.ok ? fromCents(plan.cents) : 0;
	const alreadyRefunded = payment ? hasRefund(payment) || !!payment.refunds?.length : false;
	const customerRefund = refund === "full" && !alreadyRefunded ? refundable : 0;
	return {
		...base,
		providerEarning: 0,
		platformFee: 0,
		customerRefund,
		explanation:
			refund === "full"
				? alreadyRefunded
					? "The booking becomes cancelled. The payment already has a refund, so nothing more is refunded automatically; the provider earns nothing."
					: `The booking becomes cancelled and the customer is refunded $${customerRefund.toFixed(2)} in full, as when a booking is cancelled before it starts. The provider earns nothing.`
				: "The booking becomes cancelled. Nobody is refunded and the provider earns nothing; the platform keeps the payment. Refund part of it from the payment if needed.",
	};
};

/**
 * POST /admin/bookings/:id/resolve { outcome: "completed" | "cancelled", refund?: "full" | "none", reason, confirm }.
 * For a booking stuck in progress. Without confirm: true it changes nothing and answers 409 with the preview.
 */
export const handleResolveBooking = async (req: Request, res: Response) => {
	try {
		const booking = await BookingModel.findById(req.params.id).exec();
		if (!booking) return res.status(404).json({ message: "Booking not found." });
		if (booking.status !== "in progress") {
			return res.status(409).json({ message: `This booking is ${booking.status}, not in progress.` });
		}
		const outcome = req.body.outcome as "completed" | "cancelled";
		const refund = (req.body.refund ?? "full") as "full" | "none";
		const payment = await PaymentModel.findOne({ bookingId: booking._id }).sort({ createdAt: -1 }).exec();
		const preview = resolutionPreview(booking, payment?.toObject(), outcome, refund);
		if (req.body.confirm !== true) {
			return res.status(409).json({
				message: "Confirm this action: send the same request with confirm: true.",
				code: "confirmation_required",
				preview,
			});
		}

		if (outcome === "completed") {
			if (!payment || !payment.paymentIntentId || payment.status !== "completed") {
				return res
					.status(409)
					.json({ message: "This booking has no completed payment; it cannot be completed." });
			}
			const result = await completeBookingTransition({
				booking,
				paymentAmount: payment.amount,
				completedBy: null,
				by: "admin",
				actor: { type: "admin", id: req.admin!._id },
				req,
			});
			if (!result) return res.status(409).json({ message: "This booking changed meanwhile. Reload it." });
			await recordAudit(
				{
					action: "bookings.resolved_completed",
					actor: adminActor(req),
					target: bookingTarget(booking._id),
					before: { status: "in progress" },
					after: { status: "completed", providerEarning: roundMoney(result.earning.amount) },
					reason: String(req.body.reason),
					metadata: { earningId: String(result.earning._id), releaseAt: result.releaseAt },
				},
				req,
			);
			return res.json({
				booking: bookingCore(result.completed.toObject()),
				result: { ...preview, earningId: String(result.earning._id), releaseAt: result.releaseAt },
			});
		}

		const cancelled = await cancelBookingTransition({
			bookingId: booking._id as any,
			fromStatus: "in progress",
			cancelledBy: booking.userId,
			by: "admin",
			actor: { type: "admin", id: req.admin!._id },
			properties: { onBehalfOf: "customer", wasInProgress: true },
			req,
		});
		if (!cancelled) return res.status(409).json({ message: "This booking changed meanwhile. Reload it." });
		const refundResult =
			refund === "full"
				? await describeRefund(await safeRefund(String(cancelled._id)))
				: { outcome: "not_requested", amount: 0, explanation: "No refund was requested." };
		await recordAudit(
			{
				action: "bookings.resolved_cancelled",
				actor: adminActor(req),
				target: bookingTarget(booking._id),
				before: { status: "in progress" },
				after: { status: "cancelled", refund: refundResult.outcome, refundAmount: refundResult.amount },
				reason: String(req.body.reason),
				metadata: { refundChoice: refund, refundId: (refundResult as any).refundId ?? null },
			},
			req,
		);
		res.json({ booking: bookingCore(cancelled.toObject()), result: preview, refund: refundResult });
	} catch (error) {
		answerError(res, error, "resolving booking");
	}
};
