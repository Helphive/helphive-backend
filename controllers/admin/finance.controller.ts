// Finance: reconciliation with Stripe and the money summary. Reads Stripe (never writes), compares with the database
// through the pure matcher in lib/reconciliation.ts, stores each run, and lets an admin mark a mismatch explained.
import type { Request, Response } from "express";
import stripe from "../service-accounts/stripe";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import PayoutModel from "../../dal/models/payout.model";
import UserModel from "../../dal/models/user.model";
import ReconciliationRunModel, { MAX_STORED_MISMATCHES } from "../../dal/models/reconciliationRun.model";
import {
	MISMATCH_CATEGORIES,
	MISMATCH_TYPES,
	owedVersusHeld,
	parseRange,
	reconcile,
	refundedCentsOf,
	stripeTotals,
	summariseMoney,
	type DbEarning,
	type DbPayment,
	type DbPayout,
} from "../../lib/reconciliation";
import { readPlatformBalance, readStripeRange, retrieveMissing, StripeDeadlineError } from "../../lib/stripeReads";
import { DEFAULT_SETTINGS, getSettings, stripeModeOf } from "../../lib/settings";
import { toCents, fromCents } from "../../lib/operations";
import { parseListQuery, runListQuery, ListQueryError, type ListSpec } from "../../lib/listQuery";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import { isDemoAdmin } from "../../config/adminPermissions";
import log from "../../lib/logger";
import { DETAIL_TIME_LIMIT_MS, answerError, enumParam, takeParams, within } from "./operations.shared";

/** Longest range one run or summary covers. */
export const MAX_RUN_DAYS = 31;
export const MAX_SUMMARY_DAYS = 366;
/** A run gives up reading Stripe after this (Cloud Run allows the request far longer). */
export const RUN_DEADLINE_MS = 120_000;
/** The fee every earning created before settings existed was computed with. */
const HISTORIC_FEE_PERCENT = DEFAULT_SETTINGS["payments.platformFeePercent"];

const time = DETAIL_TIME_LIMIT_MS;

const dbPayment = (p: any, contextOnly = false): DbPayment => ({
	_id: String(p._id),
	bookingId: String(p.bookingId),
	amount: p.amount,
	status: p.status,
	paymentIntentId: p.paymentIntentId ?? null,
	refundId: p.refundId ?? null,
	refundStatus: p.refundStatus ?? null,
	refundAmount: p.refundAmount ?? null,
	refunds: (p.refunds ?? []).map((r: any) => ({ refundId: r.refundId, amount: r.amount, status: r.status })),
	contextOnly,
});
const dbEarning = (e: any): DbEarning => ({
	_id: String(e._id),
	bookingId: String(e.bookingId),
	amount: e.amount,
	status: e.status,
	transferId: e.transferId ?? null,
	feePercent: e.feePercent ?? null,
});
const dbPayout = (p: any): DbPayout => ({
	_id: String(p._id),
	payoutId: p.payoutId,
	amount: p.amount,
	status: p.status,
	destinationAccount: p.destinationAccount ?? null,
});

const PAYMENT_FIELDS =
	"_id bookingId amount status paymentIntentId refundId refundStatus refundAmount refundCreated refunds paidAt createdAt";

const publicRun = (run: any) => ({
	_id: String(run._id),
	status: run.status,
	startedAt: run.startedAt,
	finishedAt: run.finishedAt,
	durationMs: run.durationMs,
	by: run.by,
	range: run.range,
	checked: run.checked,
	counts: run.counts,
	totals: run.totals,
	truncated: run.truncated,
	notes: run.notes,
	error: run.error,
	feePercent: run.feePercent,
});

const RUN_LIST_SPEC: ListSpec = {
	sortable: { startedAt: "startedAt" },
	defaultSort: "-startedAt",
	filters: { status: { type: "enum", path: "status", values: ["running", "completed", "partial", "failed"] } },
	dateField: "startedAt",
	maxPageSize: 100,
};

/** GET /admin/finance/reconciliation/runs */
export const handleListRuns = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query as Record<string, unknown>, RUN_LIST_SPEC);
		const page = await runListQuery(ReconciliationRunModel, parsed, {
			projection: { mismatches: 0 },
			map: (run) => publicRun(run),
		});
		res.json(page);
	} catch (error) {
		answerError(res, error, "listing reconciliation runs");
	}
};

/** GET /admin/finance/reconciliation/runs/:id?type=&category=&explained=&page=&pageSize= */
export const handleGetRun = async (req: Request, res: Response) => {
	try {
		const { rest, values } = takeParams(req.query as Record<string, unknown>, [
			"type",
			"category",
			"explained",
			"page",
			"pageSize",
		]);
		const unknown = Object.keys(rest)[0];
		if (unknown) throw new ListQueryError(`Unknown parameter ${unknown}.`, unknown);
		const type = enumParam(values.type, "type", MISMATCH_TYPES);
		const category = enumParam(values.category, "category", MISMATCH_CATEGORIES);
		const explained = enumParam(values.explained, "explained", ["true", "false"] as const);
		const page = Math.max(1, Number.parseInt(values.page ?? "1", 10) || 1);
		const pageSize = Math.min(200, Math.max(1, Number.parseInt(values.pageSize ?? "50", 10) || 50));

		const run = await ReconciliationRunModel.findById(req.params.id).maxTimeMS(time).lean().exec();
		if (!run) return res.status(404).json({ message: "Reconciliation run not found." });
		const filtered = (run.mismatches ?? []).filter(
			(m: any) =>
				(!type || m.type === type) &&
				(!category || m.category === category) &&
				(explained === undefined || (explained === "true") === !!m.explained),
		);
		res.json({
			run: publicRun(run),
			mismatches: {
				items: filtered.slice((page - 1) * pageSize, page * pageSize).map((m: any) => ({
					...m,
					_id: String(m._id),
					links: mismatchLinks(m),
				})),
				page,
				pageSize,
				total: filtered.length,
			},
		});
	} catch (error) {
		answerError(res, error, "reading a reconciliation run");
	}
};

const STRIPE_DASHBOARD = "https://dashboard.stripe.com";

/** Links to both records: the console path of the database record and the Stripe dashboard page. */
export const mismatchLinks = (m: {
	category: string;
	stripe?: { id?: string | null; account?: string | null } | null;
	db?: { type: string; id: string } | null;
	bookingId?: string | null;
}) => {
	const testPath = stripeMode() === "test" ? "/test" : "";
	const id = m.stripe?.id;
	let stripeUrl: string | null = null;
	if (id) {
		const path =
			m.category === "payment" || m.category === "charge"
				? `payments/${id}`
				: m.category === "refund"
					? `refunds/${id}`
					: m.category === "transfer" || m.category === "fee"
						? `connect/transfers/${id}`
						: m.category === "payout" && m.stripe?.account
							? `connect/accounts/${m.stripe.account}/payouts/${id}`
							: null;
		stripeUrl = path ? `${STRIPE_DASHBOARD}${testPath}/${path}` : null;
	}
	return {
		stripe: stripeUrl,
		db: m.db ? { type: m.db.type, id: m.db.id } : null,
		booking: m.bookingId && /^[a-f\d]{24}$/i.test(m.bookingId) ? { type: "booking", id: m.bookingId } : null,
	};
};

export const stripeMode = () => stripeModeOf(process.env.STRIPE_SECRET_KEY);

/** POST /admin/finance/reconciliation/runs { from, to } */
export const handleRunReconciliation = async (req: Request, res: Response) => {
	const range = parseRange(req.body?.from, req.body?.to, MAX_RUN_DAYS);
	if (!range.ok) return res.status(400).json({ message: range.message, field: range.field });
	const startedAt = new Date();
	const by = { id: req.admin!._id, email: req.admin!.email };
	const run = await ReconciliationRunModel.create({
		status: "running",
		startedAt,
		by,
		range: { from: range.from, to: range.to },
		feePercent: HISTORIC_FEE_PERCENT,
	});
	const notes: string[] = [];
	const budget = { deadline: Date.now() + RUN_DEADLINE_MS, notes };
	try {
		const window = { $gte: range.from, $lt: range.to };
		const [payments, earnings, payouts, accounts] = await Promise.all([
			PaymentModel.find({ createdAt: window }, PAYMENT_FIELDS)
				.maxTimeMS(time * 4)
				.lean()
				.exec(),
			EarningModel.find({ $or: [{ completionDate: window }, { status: "pending", createdAt: window }] })
				.maxTimeMS(time * 4)
				.lean()
				.exec(),
			PayoutModel.find({ createdAt: window })
				.maxTimeMS(time * 4)
				.lean()
				.exec(),
			UserModel.distinct("stripeConnectedAccountId", {
				"roles.Provider": true,
				stripeConnectedAccountId: { $nin: [null, ""] },
			})
				.maxTimeMS(time)
				.exec(),
		]);
		const stripeSide = await readStripeRange(stripe, range, accounts as string[], budget);

		// Database records the Stripe listing names that were made outside the range (context, never reported missing).
		const knownIntents = new Set(payments.map((p: any) => p.paymentIntentId).filter(Boolean));
		const knownTransfers = new Set(earnings.map((e: any) => e.transferId).filter(Boolean));
		const knownPayouts = new Set(payouts.map((p: any) => p.payoutId));
		const extraIntentIds = [
			...stripeSide.paymentIntents.map((p) => p.id),
			...stripeSide.refunds.map((r) => r.paymentIntentId).filter((id): id is string => !!id),
		].filter((id) => !knownIntents.has(id));
		const refundIds = stripeSide.refunds.map((r) => r.id);
		const [extraPayments, extraEarnings, extraPayouts] = await Promise.all([
			PaymentModel.find(
				{
					$or: [
						{ paymentIntentId: { $in: extraIntentIds } },
						{ refundId: { $in: refundIds } },
						{ "refunds.refundId": { $in: refundIds } },
					],
					_id: { $nin: payments.map((p: any) => p._id) },
				},
				PAYMENT_FIELDS,
			)
				.maxTimeMS(time)
				.lean()
				.exec(),
			EarningModel.find({
				transferId: { $in: stripeSide.transfers.map((t) => t.id).filter((id) => !knownTransfers.has(id)) },
			})
				.maxTimeMS(time)
				.lean()
				.exec(),
			PayoutModel.find({
				payoutId: { $in: stripeSide.payouts.map((p) => p.id).filter((id) => !knownPayouts.has(id)) },
			})
				.maxTimeMS(time)
				.lean()
				.exec(),
		]);
		const allEarnings = [...earnings, ...extraEarnings];
		// The payments of released earnings, for the fee check.
		const paymentIds = new Set([...payments, ...extraPayments].map((p: any) => String(p._id)));
		const feePayments = await PaymentModel.find(
			{ bookingId: { $in: allEarnings.map((e: any) => e.bookingId) }, status: "completed" },
			PAYMENT_FIELDS,
		)
			.maxTimeMS(time)
			.lean()
			.exec();
		const contextPayments = [...extraPayments, ...feePayments.filter((p: any) => !paymentIds.has(String(p._id)))];

		// Stripe objects the database names that the listing did not return, fetched one by one.
		const listedIntents = new Set(stripeSide.paymentIntents.map((p) => p.id));
		const listedRefunds = new Set(stripeSide.refunds.map((r) => r.id));
		const listedTransfers = new Set(stripeSide.transfers.map((t) => t.id));
		const listedPayouts = new Set(stripeSide.payouts.map((p) => p.id));
		const dbPayments = [...payments.map((p) => dbPayment(p)), ...contextPayments.map((p) => dbPayment(p, true))];
		const extraStripe = await retrieveMissing(
			stripe,
			{
				intents: [
					...new Set(
						dbPayments
							.filter(
								(p) =>
									p.paymentIntentId &&
									p.status !== "pending" &&
									!listedIntents.has(p.paymentIntentId),
							)
							.map((p) => p.paymentIntentId as string),
					),
				],
				refunds: [
					...new Set(
						payments.flatMap((p) =>
							[p.refundId, ...(p.refunds ?? []).map((r: any) => r.refundId)].filter(
								(id): id is string => !!id && !listedRefunds.has(id),
							),
						),
					),
				],
				transfers: allEarnings
					.map((e: any) => e.transferId)
					.filter((id: string | null): id is string => !!id && !listedTransfers.has(id)),
				payouts: [...payouts, ...extraPayouts]
					.filter((p: any) => !listedPayouts.has(p.payoutId) && p.destinationAccount)
					.map((p: any) => ({ id: p.payoutId, account: p.destinationAccount })),
			},
			budget,
		);
		const stripeAll = {
			paymentIntents: [...stripeSide.paymentIntents, ...extraStripe.paymentIntents],
			refunds: [...stripeSide.refunds, ...extraStripe.refunds],
			transfers: [...stripeSide.transfers, ...extraStripe.transfers],
			payouts: [...stripeSide.payouts, ...extraStripe.payouts],
		};
		const result = reconcile({
			stripe: stripeAll,
			db: {
				payments: dbPayments,
				earnings: allEarnings.map(dbEarning),
				payouts: [...payouts, ...extraPayouts].map(dbPayout),
			},
			defaultFeePercent: HISTORIC_FEE_PERCENT,
		});

		const inRangePayments = payments.map((p) => dbPayment(p));
		const totals = {
			stripe: stripeTotals(stripeSide),
			db: {
				paid: fromCents(
					inRangePayments.filter((p) => p.status === "completed").reduce((a, p) => a + toCents(p.amount), 0),
				),
				refunded: fromCents(inRangePayments.reduce((a, p) => a + refundedCentsOf(p), 0)),
				transferred: fromCents(
					earnings
						.filter((e: any) => e.status === "completed")
						.reduce((a, e: any) => a + toCents(e.amount), 0),
				),
				paidOut: fromCents(
					payouts.filter((p: any) => p.status === "paid").reduce((a, p: any) => a + toCents(p.amount), 0),
				),
			},
		};
		const finishedAt = new Date();
		const stored = result.mismatches.slice(0, MAX_STORED_MISMATCHES);
		const status = notes.length ? "partial" : "completed";
		await ReconciliationRunModel.updateOne(
			{ _id: run._id },
			{
				$set: {
					status,
					finishedAt,
					durationMs: finishedAt.getTime() - startedAt.getTime(),
					checked: result.checked,
					counts: { ...result.counts, explained: 0 },
					totals,
					mismatches: stored,
					truncated: stored.length < result.mismatches.length,
					notes,
				},
			},
		);
		await recordAudit(
			{
				action: "finance.reconciliation_run",
				actor: adminActor(req),
				target: { type: "reconciliationRun", id: String(run._id) },
				after: { status, range: { from: range.from, to: range.to }, mismatches: result.counts.total },
			},
			req,
		);
		emitEvent(
			{
				type: "finance.reconciliation_completed",
				actor: { type: "admin", id: req.admin!._id },
				properties: {
					runId: String(run._id),
					status,
					from: range.from,
					to: range.to,
					mismatches: result.counts.total,
					byType: result.counts.byType,
				},
			},
			req,
		);
		const saved = await ReconciliationRunModel.findById(run._id, { mismatches: 0 }).lean().exec();
		res.status(201).json({ run: publicRun(saved) });
	} catch (error: any) {
		const message =
			error instanceof StripeDeadlineError
				? error.message
				: error?.type?.startsWith?.("Stripe")
					? `Stripe refused or did not answer: ${String(error.message ?? "").slice(0, 200)}`
					: "The run failed; see the server log.";
		log.error("reconciliation_run_failed", "Reconciliation run failed", {
			runId: String(run._id),
			name: error?.name,
			code: error?.code,
		});
		const finishedAt = new Date();
		await ReconciliationRunModel.updateOne(
			{ _id: run._id },
			{
				$set: {
					status: "failed",
					finishedAt,
					durationMs: finishedAt.getTime() - startedAt.getTime(),
					error: message,
					notes,
				},
			},
		).catch(() => undefined);
		await recordAudit(
			{
				action: "finance.reconciliation_run",
				outcome: "failure",
				actor: adminActor(req),
				target: { type: "reconciliationRun", id: String(run._id) },
				metadata: { error: message },
			},
			req,
		);
		res.status(502).json({ message, runId: String(run._id), code: "reconciliation_failed" });
	}
};

/** POST /admin/finance/reconciliation/runs/:id/mismatches/:mismatchId/explain { note } */
export const handleExplainMismatch = async (req: Request, res: Response) => {
	try {
		const note = String(req.body.note).trim();
		const run = await ReconciliationRunModel.findById(req.params.id).maxTimeMS(time).exec();
		if (!run) return res.status(404).json({ message: "Reconciliation run not found." });
		const mismatch = run.mismatches.find((m: any) => String(m._id) === req.params.mismatchId);
		if (!mismatch) return res.status(404).json({ message: "Mismatch not found in this run." });
		const before = mismatch.explained ? { note: mismatch.explained.note } : null;
		const explained = { at: new Date(), by: { id: req.admin!._id, email: req.admin!.email }, note };
		const updated = await ReconciliationRunModel.findOneAndUpdate(
			{ _id: run._id, "mismatches._id": mismatch._id },
			{ $set: { "mismatches.$.explained": explained } },
			{ new: true, projection: { mismatches: 1 } },
		).exec();
		const explainedCount = (updated?.mismatches ?? []).filter((m: any) => m.explained).length;
		await ReconciliationRunModel.updateOne({ _id: run._id }, { $set: { "counts.explained": explainedCount } });
		await recordAudit(
			{
				action: "finance.mismatch_explained",
				actor: adminActor(req),
				target: { type: "reconciliationRun", id: String(run._id) },
				before,
				after: { mismatchId: String(mismatch._id), key: mismatch.key, note },
			},
			req,
		);
		emitEvent(
			{
				type: "admin.action_taken",
				actor: { type: "admin", id: req.admin!._id },
				subjects: mismatch.bookingId ? { bookingId: mismatch.bookingId } : {},
				properties: { action: "finance.mismatch_explained", targetType: "reconciliationRun" },
			},
			req,
		);
		res.json({
			mismatch: { ...(mismatch.toObject?.() ?? mismatch), _id: String(mismatch._id), explained },
			explainedCount,
		});
	} catch (error) {
		answerError(res, error, "explaining a mismatch");
	}
};

/** GET /admin/finance/summary?from=&to= : the money summary for a range, and what is owed versus held now. */
export const handleMoneySummary = async (req: Request, res: Response) => {
	try {
		const { rest, values } = takeParams(req.query as Record<string, unknown>, ["from", "to"]);
		const unknown = Object.keys(rest)[0];
		if (unknown) throw new ListQueryError(`Unknown parameter ${unknown}.`, unknown);
		const range = parseRange(values.from, values.to, MAX_SUMMARY_DAYS);
		if (!range.ok) return res.status(400).json({ message: range.message, field: range.field });
		const window = { $gte: range.from, $lt: range.to };
		const [payments, earningsCreated, earningsReleased, payouts, pending, balances, settings] = await Promise.all([
			PaymentModel.find(
				{
					$or: [
						{ paidAt: window },
						{ paidAt: null, createdAt: window },
						{ refundCreated: window },
						{ "refunds.createdAt": window },
						{ "refunds.requestedAt": window },
					],
				},
				PAYMENT_FIELDS,
			)
				.maxTimeMS(time * 2)
				.lean()
				.exec(),
			EarningModel.find({ createdAt: window }, "amount bookingId feePercent").maxTimeMS(time).lean().exec(),
			EarningModel.find({ status: "completed", completionDate: window }, "amount").maxTimeMS(time).lean().exec(),
			PayoutModel.find(
				{ $or: [{ createdAt: window }, { paidAt: window }, { failedAt: window }] },
				"amount status paidAt failedAt createdAt",
			)
				.maxTimeMS(time)
				.lean()
				.exec(),
			EarningModel.aggregate([
				{ $match: { status: "pending" } },
				{ $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
			])
				.option({ maxTimeMS: time })
				.exec(),
			UserModel.aggregate([
				{ $match: { "roles.Provider": true, availableBalance: { $gt: 0 } } },
				{ $group: { _id: null, amount: { $sum: "$availableBalance" }, count: { $sum: 1 } } },
			])
				.option({ maxTimeMS: time })
				.exec(),
			getSettings(),
		]);
		const bookingIds = earningsCreated.map((e: any) => e.bookingId);
		const paidRows = await PaymentModel.find(
			{ bookingId: { $in: bookingIds }, status: "completed" },
			"bookingId amount",
		)
			.maxTimeMS(time)
			.lean()
			.exec();
		const paidByBooking = new Map(paidRows.map((p: any) => [String(p.bookingId), p.amount as number]));
		const summary = summariseMoney({
			payments: payments.map((p: any) => ({ ...p, bookingId: String(p.bookingId) })),
			earningsCreated: earningsCreated.map((e: any) => ({ ...e, bookingId: String(e.bookingId) })),
			earningsReleased,
			paidByBooking,
			payouts,
			range: { from: range.from, to: range.to },
			defaultFeePercent: HISTORIC_FEE_PERCENT,
		});
		// The demo admin never triggers a call to Stripe.
		const platformBalance = isDemoAdmin(req.admin)
			? null
			: await within(readPlatformBalance(stripe), 5000, null).catch(() => null);
		res.json({
			range: { from: range.from, to: range.to },
			generatedAt: new Date(),
			...summary,
			owed: {
				...owedVersusHeld({
					pendingEarnings: pending[0]?.amount ?? 0,
					providerBalances: balances[0]?.amount ?? 0,
					platformBalance,
				}),
				earningsAwaitingReleaseCount: pending[0]?.count ?? 0,
				providersWithBalance: balances[0]?.count ?? 0,
				stripeBalanceStatus: isDemoAdmin(req.admin) ? "hidden_in_demo" : platformBalance ? "ok" : "unavailable",
			},
			feePercent: settings["payments.platformFeePercent"],
			stripeMode: stripeMode(),
		});
	} catch (error) {
		answerError(res, error, "building the money summary");
	}
};
