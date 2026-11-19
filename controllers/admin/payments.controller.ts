// Payments, refunds, earnings and payouts for the operations console (payments.read), and the one money action of
// this phase: an admin refund in full or in part (payments.refund).
import { Request, Response } from "express";
import mongoose from "mongoose";
import PaymentModel from "../../dal/models/payment.model";
import BookingModel from "../../dal/models/booking.model";
import EarningModel from "../../dal/models/earning.model";
import PayoutModel from "../../dal/models/payout.model";
import UserModel from "../../dal/models/user.model";
import WebhookEventModel from "../../dal/models/webhookEvent.model";
import TaskRunModel from "../../dal/models/taskRun.model";
import stripe from "../service-accounts/stripe";
import { parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import { buildSearchPlan, isSearchable, paymentSearchQueries } from "../../lib/adminSearch";
import {
	bookingReference,
	fromCents,
	platformFeeFromEarning,
	platformFeeOf,
	planRefund,
	refundTotals,
	roundMoney,
} from "../../lib/operations";
import { hasRefund } from "../user-controllers/utils/payment.utils";
import { getBookingDisplayStatus } from "../user-controllers/utils/booking.utils";
import { notifyRefundSucceeded } from "../webhook-controllers/stripe.controller";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import log from "../../lib/logger";
import {
	DETAIL_TIME_LIMIT_MS,
	answerError,
	auditFor,
	eventsFor,
	loadPeople,
	notesFor,
	oid,
	runSearch,
	takeParams,
} from "./operations.shared";
import { payoutListItem, searchUserIds } from "./users.controller";

const SEARCH_MATCH_LIMIT = 200;

const amountRange = (path: string, op: "$gte" | "$lte") => ({
	type: "custom" as const,
	parse: (value: string) => (/^\d{1,7}(\.\d{1,2})?$/.test(value) ? { [path]: { [op]: Number(value) } } : null),
});

/** A payment for admins: no client secret; refunds with what is left to refund. */
export const adminPayment = (payment: any) => {
	const totals = refundTotals(payment);
	const refunded = hasRefund(payment) || !!payment.refunds?.length;
	return {
		_id: String(payment._id),
		bookingId: String(payment.bookingId),
		bookingReference: bookingReference(payment.bookingId),
		amount: roundMoney(payment.amount),
		platformFee: payment.status === "completed" ? platformFeeOf(payment.amount) : 0,
		status: payment.status,
		createdAt: payment.createdAt ?? payment.date,
		paidAt: payment.paidAt ?? (payment.status === "completed" ? payment.date : null),
		paymentIntentId: payment.paymentIntentId ?? null,
		paymentMethod: payment.paymentMethod ?? null,
		refund: refunded
			? {
					latestRefundId: payment.refundId ?? null,
					status: payment.refundStatus ?? null,
					totalRefunded: fromCents(totals.committedCents),
					succeeded: fromCents(totals.succeededCents),
					refundedAt: payment.refundCreated ?? null,
					destinationType: payment.destinationDetails?.type ?? null,
				}
			: null,
		refunds: (payment.refunds ?? []).map((entry: any) => ({
			refundId: entry.refundId ?? null,
			amount: roundMoney(entry.amount),
			status: entry.status,
			requestedAt: entry.requestedAt,
			createdAt: entry.createdAt ?? null,
			source: entry.source,
		})),
		remainingRefundable: fromCents(totals.remainingCents),
	};
};

export const PAYMENT_LIST_SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", amount: "amount", paidAt: "paidAt", refundCreated: "refundCreated" },
	defaultSort: "-createdAt",
	filters: {
		status: { type: "enum", path: "status", values: ["pending", "completed", "cancelled"] },
		refundState: {
			type: "custom",
			parse: (value) => {
				const refunded = { refundId: { $type: "string" } };
				if (value === "none") return { refundId: { $not: { $type: "string" } } };
				if (value === "any") return refunded;
				if (["pending", "succeeded", "failed", "cancelled"].includes(value))
					return { ...refunded, refundStatus: value };
				return null;
			},
		},
		bookingId: { type: "objectId", path: "bookingId" },
		amountMin: amountRange("amount", "$gte"),
		amountMax: amountRange("amount", "$lte"),
	},
	dateField: "createdAt",
	maxPageSize: 100,
};

const paymentSearchFilter = async (q: string | undefined) => {
	if (q === undefined) return null;
	const plan = buildSearchPlan(q);
	if (!isSearchable(plan)) return { _id: { $in: [] } };
	const [own, people] = await Promise.all([
		runSearch<{ _id: unknown }>(PaymentModel, paymentSearchQueries(plan), {
			limit: SEARCH_MATCH_LIMIT,
			projection: "_id",
		}),
		plan.email || plan.names || plan.phone ? searchUserIds(q) : Promise.resolve([]),
	]);
	const or: Record<string, unknown>[] = [{ _id: { $in: own.map((p) => p._id) } }];
	if (plan.reference) {
		const bookings = await BookingModel.find({ reference: plan.reference }, "_id").limit(5).lean().exec();
		if (bookings.length) or.push({ bookingId: { $in: bookings.map((b) => b._id) } });
	}
	if (people?.length) {
		const bookings = await BookingModel.distinct("_id", { userId: { $in: people } })
			.maxTimeMS(DETAIL_TIME_LIMIT_MS)
			.exec();
		or.push({ bookingId: { $in: bookings } });
	}
	return { $or: or };
};

/** GET /admin/payments */
export const handleListPayments = async (req: Request, res: Response) => {
	try {
		const { rest, values } = takeParams(req.query as Record<string, unknown>, ["q"]);
		const parsed = parseListQuery(rest, PAYMENT_LIST_SPEC);
		const search = await paymentSearchFilter(values.q);
		const page = await runListQuery(PaymentModel, parsed, { baseFilter: search ?? undefined });
		const bookings = await BookingModel.find(
			{ _id: { $in: page.items.map((p: any) => p.bookingId) } },
			"userId providerId service startDate status userApprovalRequested cancellationReason cancelledAt",
		)
			.lean()
			.exec();
		const bookingById = new Map(bookings.map((b) => [String(b._id), b]));
		const people = await loadPeople(bookings.map((b) => b.userId));
		res.json({
			...page,
			items: page.items.map((payment: any) => {
				const booking: any = bookingById.get(String(payment.bookingId));
				return {
					...adminPayment(payment),
					booking: booking
						? {
								_id: String(booking._id),
								reference: bookingReference(booking._id),
								service: booking.service,
								startDate: booking.startDate,
								displayStatus: getBookingDisplayStatus(booking),
							}
						: null,
					customer: booking ? (people.get(String(booking.userId)) ?? null) : null,
				};
			}),
		});
	} catch (error) {
		answerError(res, error, "listing payments");
	}
};

/** Webhook deliveries about any of these Stripe objects (recorded from this release on). */
const webhookEventsAbout = async (objectIds: (string | null | undefined)[]) => {
	const ids = [...new Set(objectIds.filter((id): id is string => !!id))];
	if (!ids.length) return [];
	const events = await WebhookEventModel.find({ objectId: { $in: ids } })
		.sort({ receivedAt: -1 })
		.limit(50)
		.maxTimeMS(DETAIL_TIME_LIMIT_MS)
		.lean()
		.exec();
	return events.map((event) => ({
		_id: String(event._id),
		eventId: event.eventId,
		type: event.type,
		objectId: event.objectId ?? null,
		endpoint: event.endpoint,
		outcome: event.outcome,
		receivedAt: event.receivedAt,
		processedAt: event.processedAt ?? null,
		deliveries: event.deliveries,
		note: event.note ?? null,
		error: event.error ?? null,
	}));
};

/** GET /admin/payments/:id */
export const handleGetPayment = async (req: Request, res: Response) => {
	try {
		const payment: any = await PaymentModel.findById(req.params.id).maxTimeMS(DETAIL_TIME_LIMIT_MS).lean().exec();
		if (!payment) return res.status(404).json({ message: "Payment not found." });
		const booking: any = await BookingModel.findById(payment.bookingId).lean().exec();
		const [people, earning, webhookEvents, events, notes, audit] = await Promise.all([
			loadPeople([booking?.userId, booking?.providerId]),
			EarningModel.findOne({ bookingId: payment.bookingId }).lean().exec(),
			webhookEventsAbout([
				payment.paymentIntentId,
				payment.refundId,
				...(payment.refunds ?? []).map((r: any) => r.refundId),
			]),
			eventsFor({ paymentId: payment._id }, 50),
			notesFor("payment", payment._id),
			auditFor(req, "payment", payment._id),
		]);
		res.json({
			payment: {
				...adminPayment(payment),
				platformFee: earning
					? roundMoney(payment.amount - earning.amount)
					: payment.status === "completed"
						? platformFeeOf(payment.amount)
						: 0,
				providerShare: earning ? roundMoney(earning.amount) : null,
			},
			booking: booking
				? {
						_id: String(booking._id),
						reference: bookingReference(booking._id),
						status: booking.status,
						displayStatus: getBookingDisplayStatus(booking),
						service: booking.service,
						startDate: booking.startDate,
						amount: roundMoney(booking.rate * booking.hours),
					}
				: null,
			customer: booking ? (people.get(String(booking.userId)) ?? null) : null,
			provider: booking?.providerId ? (people.get(String(booking.providerId)) ?? null) : null,
			earning: earning
				? {
						_id: String(earning._id),
						amount: roundMoney(earning.amount),
						status: earning.status,
						createdAt: (earning as any).createdAt,
						releasedAt: earning.completionDate ?? null,
						transferId: earning.transferId ?? null,
					}
				: null,
			webhookEvents,
			timeline: events,
			notes,
			audit,
		});
	} catch (error) {
		answerError(res, error, "getting payment");
	}
};

// --- Refund ----------------------------------------------------------------------------------------------------

const STRIPE_REFUND_STATUS: Record<string, "pending" | "succeeded" | "failed" | "cancelled"> = {
	pending: "pending",
	requires_action: "pending",
	succeeded: "succeeded",
	failed: "failed",
	canceled: "cancelled",
};

const paymentTarget = (id: unknown) => ({ type: "payment", id: String(id) });

/** Stripe refused the request outright (nothing was refunded), as opposed to not answering. */
const isDefinitiveStripeRefusal = (error: any) =>
	error?.type === "StripeInvalidRequestError" || error?.type === "StripeCardError" || error?.statusCode === 400;

/**
 * POST /admin/payments/:id/refund { amount?, reason, idempotencyKey }
 *
 * Safe under repeats and concurrency:
 * 1. `idempotencyKey` (one per refund dialog in the console) is stored with the refund. Sending the same request again
 *    returns the first result; if the first attempt never heard back from Stripe, the retry finishes it with the same
 *    Stripe idempotency key, so Stripe returns the same refund instead of making a second.
 * 2. The amount is checked against what is left (paid minus every refund made or reserved) and reserved with an
 *    update that applies only to the refund version it read. Two different requests at once: one wins, the other
 *    gets 409 and nothing is sent to Stripe for it.
 * 3. Stripe itself refuses to refund more than the charge.
 */
export const handleRefundPayment = async (req: Request, res: Response) => {
	const key = String(req.body.idempotencyKey);
	const reason = String(req.body.reason);
	const requested = req.body.amount === undefined || req.body.amount === null ? null : Number(req.body.amount);
	try {
		const payment = await PaymentModel.findById(req.params.id).exec();
		if (!payment) return res.status(404).json({ message: "Payment not found." });

		let entry = payment.refunds?.find((item) => item.idempotencyKey === key) ?? null;
		if (entry?.refundId) {
			return res.json({ replayed: true, payment: adminPayment(payment.toObject()), refund: refundView(entry) });
		}
		if (entry?.status === "failed") {
			return res.status(409).json({
				message: "This refund request already failed at Stripe. Start a new refund to try again.",
				code: "refund_failed",
			});
		}

		if (!entry) {
			const plan = planRefund(payment.toObject() as any, requested);
			if (!plan.ok) {
				const messages = {
					not_paid: "This payment was not completed, so there is nothing to refund.",
					nothing_left: "This payment has been refunded in full already.",
					too_much: `That is more than is left to refund ($${fromCents(plan.remainingCents).toFixed(2)}).`,
					invalid_amount: "Give an amount in dollars with at most two decimals, above zero.",
				};
				return res.status(plan.code === "invalid_amount" ? 400 : 409).json({
					message: messages[plan.code],
					code: plan.code,
					remainingRefundable: fromCents(plan.remainingCents),
				});
			}
			const newEntry = {
				idempotencyKey: key,
				amount: fromCents(plan.cents),
				status: "requested" as const,
				refundId: null,
				requestedAt: new Date(),
				createdAt: null,
				source: "admin" as const,
			};
			// Applies only if nobody refunded this payment since it was read (version) and the key is new.
			const reserved = await PaymentModel.findOneAndUpdate(
				{
					_id: payment._id,
					refundVersion: payment.refundVersion ?? null,
					"refunds.idempotencyKey": { $ne: key },
					refundId: payment.refundId ?? null,
				},
				{ $inc: { refundVersion: 1 }, $push: { refunds: newEntry } },
				{ new: true },
			).exec();
			if (!reserved) {
				// A double submission of this same request lost the race to itself: point at the one in flight.
				if (await PaymentModel.exists({ _id: payment._id, "refunds.idempotencyKey": key })) {
					return res.status(409).json({
						message:
							"This refund is already being processed. Send the same request again in a moment to see its result.",
						code: "refund_in_progress",
					});
				}
				return res.status(409).json({
					message:
						"Another refund on this payment was made at the same moment. Reload the payment and check what is left.",
					code: "refund_conflict",
				});
			}
			entry = reserved.refunds!.find((item) => item.idempotencyKey === key)!;
		}

		const before = refundTotals(payment.toObject() as any);
		let refund;
		try {
			refund = await stripe.refunds.create(
				{
					payment_intent: payment.paymentIntentId,
					amount: Math.round(entry.amount * 100),
					metadata: { paymentId: String(payment._id), bookingId: String(payment.bookingId), source: "admin" },
				},
				{ idempotencyKey: `admin-refund-${String(payment._id)}-${key}` },
			);
		} catch (error: any) {
			const definitive = isDefinitiveStripeRefusal(error);
			if (definitive) {
				await PaymentModel.updateOne(
					{ _id: payment._id, "refunds.idempotencyKey": key },
					{ $set: { "refunds.$.status": "failed" } },
				);
			}
			log.error(`Admin refund of payment ${String(payment._id)} failed`, error);
			await recordAudit(
				{
					action: "payments.refunded",
					outcome: "failure",
					actor: adminActor(req),
					target: paymentTarget(payment._id),
					before: { totalRefunded: fromCents(before.committedCents) },
					reason,
					metadata: {
						amount: entry.amount,
						idempotencyKey: key,
						stripeError: error?.code ?? error?.type ?? null,
					},
				},
				req,
			);
			return res.status(502).json(
				definitive
					? {
							message: `Stripe refused the refund: ${String(error?.message ?? "unknown error").slice(0, 200)}`,
							code: "stripe_refused",
						}
					: {
							message:
								"Stripe did not answer. Send the same request again (same idempotencyKey) to finish it; it cannot refund twice.",
							code: "stripe_unavailable",
						},
			);
		}

		const status = STRIPE_REFUND_STATUS[refund.status ?? "pending"] ?? "pending";
		const createdAt = new Date(refund.created * 1000);
		await PaymentModel.updateOne(
			{ _id: payment._id, "refunds.idempotencyKey": key },
			{ $set: { "refunds.$.refundId": refund.id, "refunds.$.status": status, "refunds.$.createdAt": createdAt } },
		);
		// The top-level fields the apps and the receipt read: latest refund, total refunded.
		const updated = await PaymentModel.findById(payment._id).exec();
		const totals = refundTotals(updated!.toObject() as any);
		updated!.refundId = refund.id;
		updated!.refundStatus = status;
		updated!.refundAmount = fromCents(totals.committedCents);
		updated!.refundCreated = createdAt;
		updated!.destinationDetails = { type: refund.destination_details?.type };
		await updated!.save();

		const amount = refund.amount / 100;
		emitEvent(
			{
				type: "refund.created",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { bookingId: payment.bookingId as any, paymentId: payment._id as any },
				properties: {
					amount,
					by: "admin",
					partial: Math.round(amount * 100) < Math.round(payment.amount * 100),
				},
			},
			req,
		);
		await recordAudit(
			{
				action: "payments.refunded",
				actor: adminActor(req),
				target: paymentTarget(payment._id),
				before: {
					totalRefunded: fromCents(before.committedCents),
					remaining: fromCents(before.remainingCents),
				},
				after: { totalRefunded: fromCents(totals.committedCents), remaining: fromCents(totals.remainingCents) },
				reason,
				metadata: { refundId: refund.id, amount, status, idempotencyKey: key },
			},
			req,
		);
		// Stripe usually confirms card refunds later (refund.updated webhook, which notifies the customer). When it
		// has already succeeded no webhook transition follows, so notify now, as the webhook would.
		if (status === "succeeded") await notifyRefundSucceeded(updated!, amount, refund.id);

		res.json({
			replayed: false,
			payment: adminPayment(updated!.toObject()),
			refund: { refundId: refund.id, amount: roundMoney(amount), status, createdAt },
		});
	} catch (error) {
		answerError(res, error, "refunding payment");
	}
};

const refundView = (entry: any) => ({
	refundId: entry.refundId ?? null,
	amount: roundMoney(entry.amount),
	status: entry.status,
	createdAt: entry.createdAt ?? null,
});

// --- Earnings ----------------------------------------------------------------------------------------------------

const providerBookingFilter = async (providerId: string | undefined) => {
	if (!providerId) return null;
	const ids = await BookingModel.distinct("_id", { providerId: oid(providerId) })
		.maxTimeMS(DETAIL_TIME_LIMIT_MS)
		.exec();
	return { bookingId: { $in: ids } };
};

export const EARNING_LIST_SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", amount: "amount", completionDate: "completionDate" },
	defaultSort: "-createdAt",
	filters: {
		status: { type: "enum", path: "status", values: ["pending", "completed", "cancelled"] },
		bookingId: { type: "objectId", path: "bookingId" },
		amountMin: amountRange("amount", "$gte"),
		amountMax: amountRange("amount", "$lte"),
	},
	dateField: "createdAt",
	maxPageSize: 100,
};

const earningItem = (earning: any, booking: any, provider: any) => ({
	_id: String(earning._id),
	amount: roundMoney(earning.amount),
	platformFee: platformFeeFromEarning(earning.amount),
	status: earning.status,
	createdAt: earning.createdAt ?? earning.date,
	releasedAt: earning.completionDate ?? null,
	transferId: earning.transferId ?? null,
	booking: booking
		? {
				_id: String(booking._id),
				reference: bookingReference(booking._id),
				service: booking.service,
				completedAt: booking.completedAt ?? null,
			}
		: { _id: String(earning.bookingId), reference: bookingReference(earning.bookingId) },
	provider: provider ?? null,
});

/** GET /admin/earnings */
export const handleListEarnings = async (req: Request, res: Response) => {
	try {
		const { rest, values } = takeParams(req.query as Record<string, unknown>, ["providerId"]);
		if (values.providerId && !/^[a-f\d]{24}$/i.test(values.providerId)) {
			return res.status(400).json({ message: "providerId must be an id.", field: "providerId" });
		}
		const parsed = parseListQuery(rest, EARNING_LIST_SPEC);
		const byProvider = await providerBookingFilter(values.providerId);
		const page = await runListQuery(EarningModel, parsed, { baseFilter: byProvider ?? undefined });
		const bookings = await BookingModel.find(
			{ _id: { $in: page.items.map((e: any) => e.bookingId) } },
			"providerId service completedAt",
		)
			.lean()
			.exec();
		const bookingById = new Map(bookings.map((b) => [String(b._id), b]));
		const people = await loadPeople(bookings.map((b) => b.providerId));
		res.json({
			...page,
			items: page.items.map((earning: any) => {
				const booking: any = bookingById.get(String(earning.bookingId));
				return earningItem(earning, booking, booking ? people.get(String(booking.providerId)) : null);
			}),
		});
	} catch (error) {
		answerError(res, error, "listing earnings");
	}
};

/** GET /admin/earnings/:id */
export const handleGetEarning = async (req: Request, res: Response) => {
	try {
		const earning: any = await EarningModel.findById(req.params.id).lean().exec();
		if (!earning) return res.status(404).json({ message: "Earning not found." });
		const booking: any = await BookingModel.findById(earning.bookingId).lean().exec();
		const [people, payment, taskRuns, events] = await Promise.all([
			loadPeople([booking?.providerId, booking?.userId]),
			PaymentModel.findOne({ bookingId: earning.bookingId }).sort({ createdAt: -1 }).lean().exec(),
			TaskRunModel.find({ bookingId: String(earning.bookingId), task: "earning-complete" })
				.sort({ receivedAt: -1 })
				.limit(20)
				.lean()
				.exec(),
			eventsFor({ earningId: earning._id }, 50),
		]);
		res.json({
			earning: earningItem(earning, booking, booking ? people.get(String(booking.providerId)) : null),
			customer: booking ? (people.get(String(booking.userId)) ?? null) : null,
			payment: payment ? adminPayment(payment) : null,
			taskRuns: taskRuns.map((run: any) => ({
				_id: String(run._id),
				outcome: run.outcome,
				status: run.status,
				receivedAt: run.receivedAt,
				retryCount: run.retryCount ?? null,
				note: run.note ?? null,
				error: run.error ?? null,
			})),
			timeline: events,
		});
	} catch (error) {
		answerError(res, error, "getting earning");
	}
};

// --- Payouts -----------------------------------------------------------------------------------------------------

export const PAYOUT_LIST_SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", amount: "amount", paidAt: "paidAt" },
	defaultSort: "-createdAt",
	filters: {
		status: { type: "enum", path: "status", values: ["pending", "paid", "failed", "cancelled"] },
		providerId: { type: "objectId", path: "userId" },
		amountMin: amountRange("amount", "$gte"),
		amountMax: amountRange("amount", "$lte"),
	},
	dateField: "createdAt",
	maxPageSize: 100,
};

/** GET /admin/payouts */
export const handleListPayouts = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query as Record<string, unknown>, PAYOUT_LIST_SPEC);
		const page = await runListQuery(PayoutModel, parsed);
		const people = await loadPeople(page.items.map((p: any) => p.userId));
		res.json({
			...page,
			items: page.items.map((payout: any) => ({
				...payoutListItem(payout),
				provider: people.get(String(payout.userId)) ?? null,
			})),
		});
	} catch (error) {
		answerError(res, error, "listing payouts");
	}
};

/** GET /admin/payouts/:id */
export const handleGetPayout = async (req: Request, res: Response) => {
	try {
		const payout: any = await PayoutModel.findById(req.params.id).lean().exec();
		if (!payout) return res.status(404).json({ message: "Payout not found." });
		const [people, webhookEvents, events] = await Promise.all([
			loadPeople([payout.userId]),
			webhookEventsAbout([payout.payoutId]),
			eventsFor({ payoutId: payout._id }, 50),
		]);
		res.json({
			payout: { ...payoutListItem(payout), destinationAccount: payout.destinationAccount ?? null },
			provider: people.get(String(payout.userId)) ?? null,
			webhookEvents,
			timeline: events,
		});
	} catch (error) {
		answerError(res, error, "getting payout");
	}
};

/** GET /admin/users/:id/balance: a provider's balance, earnings by state and payouts by state. */
export const handleGetProviderBalance = async (req: Request, res: Response) => {
	try {
		const user: any = await UserModel.findById(req.params.id, "roles availableBalance firstName lastName email")
			.lean()
			.exec();
		if (!user) return res.status(404).json({ message: "User not found." });
		if (!user.roles?.Provider) return res.status(409).json({ message: "This account is not a provider." });
		const bookingIds = await BookingModel.distinct("_id", { providerId: user._id }).exec();
		const [earnings, payouts, lastPayout] = await Promise.all([
			EarningModel.aggregate([
				{ $match: { bookingId: { $in: bookingIds } } },
				{ $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
			]),
			PayoutModel.aggregate([
				{ $match: { userId: new mongoose.Types.ObjectId(String(user._id)) } },
				{ $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
			]),
			PayoutModel.findOne({ userId: user._id }).sort({ createdAt: -1 }).lean().exec(),
		]);
		const sums = (rows: any[]) =>
			Object.fromEntries(rows.map((row) => [row._id, { count: row.count, amount: roundMoney(row.amount) }]));
		const e = sums(earnings);
		const p = sums(payouts);
		res.json({
			providerId: String(user._id),
			availableBalance: roundMoney(user.availableBalance ?? 0),
			awaitingRelease: e.pending ?? { count: 0, amount: 0 },
			released: e.completed ?? { count: 0, amount: 0 },
			earnings: e,
			payouts: p,
			inFlight: p.pending ?? { count: 0, amount: 0 },
			lastPayout: lastPayout ? payoutListItem(lastPayout) : null,
			explanation:
				"Released earnings are added to the available balance; payouts take from it (a failed or cancelled payout gives it back).",
		});
	} catch (error) {
		answerError(res, error, "getting provider balance");
	}
};
