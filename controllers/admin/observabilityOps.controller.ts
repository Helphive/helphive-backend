// Observability console, operations side: webhook events and task runs (lists, failure rates, replay), the alert
// inbox and alert rules (CRUD, preview), the module's metadata, and the public client-error ingestion.
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import type Stripe from "stripe";
import WebhookEventModel, { WEBHOOK_OUTCOMES } from "../../dal/models/webhookEvent.model";
import TaskRunModel, { TASK_OUTCOMES } from "../../dal/models/taskRun.model";
import { AlertModel, AlertRuleModel, DependencyCheckModel } from "../../dal/models/obsOps.model";
import { ErrorGroupModel } from "../../dal/models/obsError.model";
import EventModel from "../../dal/models/event.model";
import AuditLogModel from "../../dal/models/auditLog.model";
import AdminModel from "../../dal/models/admin.model";
import UserModel from "../../dal/models/user.model";
import { ListQueryError, parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import { adminActor, recordAudit, type AuditAction } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import { runWithContext } from "../../lib/requestContext";
import { taskOutcomeFor, type WebhookDelivery } from "../../lib/webhookRecorder";
import { answerError } from "./operations.shared";
import { requestLinks, isObjectId } from "./observability.controller";
import {
	REPLAYABLE_STRIPE_TYPES,
	REPLAYABLE_TASKS,
	taskReplayEligibility,
	webhookReplayEligibility,
} from "../../lib/observability/replay";
import {
	ALERT_KINDS,
	RuleInputError,
	parseRuleInput,
	simulateRule,
	type AlertRuleInput,
	type MinuteMeasures,
} from "../../lib/observability/alertRules";
import { minuteTotals, parseRange } from "../../lib/observability/queries";
import { DEPENDENCIES } from "../../lib/observability/dependencies";
import { captureError } from "../../lib/observability/runtime";
import { scrubText } from "../../lib/observability/scrub";
import { hasPermission } from "../../config/adminPermissions";
import { ADMIN_TOKEN_AUDIENCE, adminTokenSecret } from "../../config/adminAuth";
import { retention, revision } from "../../lib/observability/config";
import log from "../../lib/logger";

const HOUR = 60 * 60_000;

const answer = (res: Response, error: unknown, what: string) => {
	if (error instanceof RuleInputError) return res.status(400).json({ message: error.message, field: error.field });
	return answerError(res, error, what);
};

const adminEvent = (req: Request, action: AuditAction, targetType: string, extra: Record<string, unknown> = {}) =>
	emitEvent(
		{
			type: "admin.action_taken",
			actor: { type: "admin", id: req.admin!._id },
			properties: { action, targetType, ...extra },
		},
		req,
	);

/** Failure rate per time bucket for a collection (webhooks or tasks). */
const failureSeries = async (
	model: mongoose.Model<any>,
	failed: Record<string, unknown>,
	window: { from: Date; to: Date; bucketMs: number },
	groupField: string,
) => {
	const bucketMs = window.bucketMs;
	const rows = await model
		.aggregate([
			{ $match: { receivedAt: { $gte: window.from, $lt: window.to } } },
			{
				$group: {
					_id: {
						t: {
							$toDate: {
								$subtract: [
									{ $toLong: "$receivedAt" },
									{ $mod: [{ $toLong: "$receivedAt" }, bucketMs] },
								],
							},
						},
						k: `$${groupField}`,
					},
					total: { $sum: 1 },
					failed: { $sum: { $cond: [failed, 1, 0] } },
				},
			},
		])
		.option({ maxTimeMS: 5000 });
	const start = Math.floor(window.from.getTime() / bucketMs) * bucketMs;
	const points = Math.ceil((window.to.getTime() - start) / bucketMs);
	const series = Array.from({ length: points }, (_, i) => ({
		t: new Date(start + i * bucketMs).toISOString(),
		total: 0,
		failed: 0,
	}));
	const byKey = new Map<string, { key: string; total: number; failed: number }>();
	for (const row of rows) {
		const index = Math.floor((new Date(row._id.t).getTime() - start) / bucketMs);
		if (index >= 0 && index < points) {
			series[index].total += row.total;
			series[index].failed += row.failed;
		}
		const key = String(row._id.k ?? "unknown");
		const entry = byKey.get(key) ?? { key, total: 0, failed: 0 };
		entry.total += row.total;
		entry.failed += row.failed;
		byKey.set(key, entry);
	}
	const total = series.reduce((s, p) => s + p.total, 0);
	const failedTotal = series.reduce((s, p) => s + p.failed, 0);
	return {
		total,
		failed: failedTotal,
		failureRate: total ? Math.round((1000 * failedTotal) / total) / 10 : null,
		series,
		byKey: [...byKey.values()].sort((a, b) => b.failed - a.failed || b.total - a.total),
	};
};

// --- Webhooks -----------------------------------------------------------------------------------------------------

export const WEBHOOK_LIST_SPEC: ListSpec = {
	sortable: { receivedAt: "receivedAt", type: "type", deliveries: "deliveries" },
	defaultSort: "-receivedAt",
	filters: {
		outcome: { type: "enum", path: "outcome", values: WEBHOOK_OUTCOMES },
		type: { type: "string", path: "type", maxLength: 100 },
		endpoint: { type: "enum", path: "endpoint", values: ["platform", "connected"] },
		objectId: { type: "string", path: "objectId", maxLength: 255 },
		requestId: { type: "string", path: "requestId", maxLength: 64 },
	},
	dateField: "receivedAt",
	searchFields: ["eventId", "type", "objectId"],
	maxPageSize: 100,
};

const publicWebhook = (w: any, now = new Date()) => {
	const eligibility = webhookReplayEligibility(w, now);
	return {
		id: String(w._id),
		provider: w.provider,
		endpoint: w.endpoint,
		eventId: w.eventId,
		type: w.type,
		account: w.account ?? null,
		objectId: w.objectId ?? null,
		livemode: w.livemode ?? null,
		receivedAt: w.receivedAt,
		processedAt: w.processedAt ?? null,
		durationMs: w.processedAt ? new Date(w.processedAt).getTime() - new Date(w.receivedAt).getTime() : null,
		outcome: w.outcome,
		note: w.note ?? null,
		error: w.error ?? null,
		deliveries: w.deliveries ?? 1,
		lastDeliveryAt: w.lastDeliveryAt ?? null,
		requestId: w.requestId ?? null,
		replays: w.replays ?? [],
		replay: eligibility,
		...requestLinks(w.requestId, w.lastDeliveryAt ?? w.receivedAt),
	};
};

/** GET /observability/webhooks */
export const handleListWebhooks = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query, WEBHOOK_LIST_SPEC);
		res.json(await runListQuery(WebhookEventModel, parsed, { map: (w) => publicWebhook(w) }));
	} catch (error) {
		answer(res, error, "listing webhook events");
	}
};

/** GET /observability/webhooks/stats?range= */
export const handleWebhookStats = async (req: Request, res: Response) => {
	try {
		const window = parseRange(req.query.range, "7d");
		const stats = await failureSeries(WebhookEventModel, { $eq: ["$outcome", "failed"] }, window, "type");
		res.json({ range: window.range, from: window.from, to: window.to, bucketMs: window.bucketMs, ...stats });
	} catch (error) {
		answer(res, error, "reading webhook statistics");
	}
};

/** Related booking or payment for a webhook's object id (payment intent, refund, payout). */
const webhookRelated = async (objectId: string | null) => {
	if (!objectId) return null;
	const db = mongoose.connection.db;
	if (!db) return null;
	if (/^(pi|re)_/.test(objectId)) {
		const payment = await db
			.collection("payments")
			.findOne(
				{ $or: [{ paymentIntentId: objectId }, { refundId: objectId }, { "refunds.refundId": objectId }] },
				{ projection: { _id: 1, bookingId: 1 }, maxTimeMS: 3000 },
			);
		return payment
			? { paymentId: String(payment._id), bookingId: payment.bookingId ? String(payment.bookingId) : null }
			: null;
	}
	if (/^po_/.test(objectId)) {
		const payout = await db
			.collection("payouts")
			.findOne({ payoutId: objectId }, { projection: { _id: 1, userId: 1 }, maxTimeMS: 3000 });
		return payout ? { payoutId: String(payout._id), userId: payout.userId ? String(payout.userId) : null } : null;
	}
	return null;
};

/** GET /observability/webhooks/:id */
export const handleGetWebhook = async (req: Request, res: Response) => {
	try {
		const record = await WebhookEventModel.findById(req.params.id).lean();
		if (!record) return res.status(404).json({ message: "Webhook event not found." });
		res.json({ webhook: publicWebhook(record), related: await webhookRelated(record.objectId ?? null) });
	} catch (error) {
		answer(res, error, "reading a webhook event");
	}
};

const REPLAY_WAIT_MS = 25_000;

/** POST /observability/webhooks/:id/replay { confirm: true, reason } : fetch the event from Stripe and run its handler. */
export const handleReplayWebhook = async (req: Request, res: Response) => {
	try {
		if (req.body.confirm !== true) {
			return res.status(400).json({
				message: "Replaying runs the handler again. Send confirm: true to go ahead.",
				field: "confirm",
			});
		}
		const record = await WebhookEventModel.findById(req.params.id).lean();
		if (!record) return res.status(404).json({ message: "Webhook event not found." });
		const eligibility = webhookReplayEligibility(record);
		if (!eligibility.eligible) return res.status(409).json({ message: eligibility.reason });

		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const stripe = require("../service-accounts/stripe").default as Stripe;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const handlers = require("../webhook-controllers/stripe.controller");
		let event: Stripe.Event;
		try {
			event = await stripe.events.retrieve(
				record.eventId,
				record.endpoint === "connected" && record.account ? { stripeAccount: record.account } : undefined,
			);
		} catch (error: any) {
			return res.status(502).json({
				message: `Stripe did not return the event: ${String(error?.message ?? "error").slice(0, 200)}`,
			});
		}

		const by = req.admin!.email;
		const outcome = await new Promise<{ outcome: string; error: string | null; note: string | null }>((resolve) => {
			const timer = setTimeout(
				() => resolve({ outcome: "running", error: null, note: "still running; check back shortly" }),
				REPLAY_WAIT_MS,
			);
			const delivery: WebhookDelivery = {
				shouldProcess: true,
				finish: (result, detail = {}) => {
					clearTimeout(timer);
					const error = detail.error
						? String((detail.error as Error)?.message ?? detail.error).slice(0, 1000)
						: null;
					WebhookEventModel.updateOne(
						{ _id: record._id },
						{
							$set: { outcome: result, processedAt: new Date(), note: detail.note ?? null, error },
							$push: {
								replays: {
									at: new Date(),
									by,
									outcome: result,
									error,
									requestId: req.context?.requestId ?? null,
								},
							},
						},
					)
						.exec()
						.catch((e) =>
							log.error("record_webhook_replay_failed", "Could not record a webhook replay outcome", e),
						);
					resolve({ outcome: result, error, note: detail.note ?? null });
				},
			};
			const run = () =>
				record.endpoint === "connected"
					? handlers.handleConnectedEvent(event, delivery)
					: handlers.handlePlatformEvent(event, delivery);
			try {
				if (req.context) runWithContext(req.context, run);
				else run();
			} catch (error) {
				delivery.finish("failed", { error });
			}
		});
		await recordAudit(
			{
				action: "observability.webhook_replayed",
				actor: adminActor(req),
				target: { type: "webhook_event", id: String(record._id) },
				before: { outcome: record.outcome },
				after: { outcome: outcome.outcome },
				reason: req.body.reason ? String(req.body.reason) : null,
				metadata: { eventId: record.eventId, type: record.type, error: outcome.error },
			},
			req,
		);
		adminEvent(req, "observability.webhook_replayed", "webhook_event", { outcome: outcome.outcome });
		const updated = await WebhookEventModel.findById(record._id).lean();
		res.json({ result: outcome, webhook: publicWebhook(updated ?? record) });
	} catch (error) {
		answer(res, error, "replaying a webhook event");
	}
};

// --- Tasks --------------------------------------------------------------------------------------------------------

export const TASK_LIST_SPEC: ListSpec = {
	sortable: { receivedAt: "receivedAt", durationMs: "durationMs", task: "task" },
	defaultSort: "-receivedAt",
	filters: {
		outcome: { type: "enum", path: "outcome", values: TASK_OUTCOMES },
		task: { type: "enum", path: "task", values: Object.keys(REPLAYABLE_TASKS) },
		bookingId: { type: "string", path: "bookingId", maxLength: 64 },
		requestId: { type: "string", path: "requestId", maxLength: 64 },
	},
	dateField: "receivedAt",
	searchFields: ["taskName", "bookingId"],
	maxPageSize: 100,
};

const publicTask = (t: any) => ({
	id: String(t._id),
	task: t.task,
	taskName: t.taskName ?? null,
	queue: t.queue ?? null,
	retryCount: t.retryCount ?? null,
	executionCount: t.executionCount ?? null,
	bookingId: t.bookingId ?? null,
	receivedAt: t.receivedAt,
	processedAt: t.processedAt,
	durationMs: t.durationMs,
	status: t.status,
	outcome: t.outcome,
	note: t.note ?? null,
	error: t.error ?? null,
	requestId: t.requestId ?? null,
	replayOf: t.replayOf ? String(t.replayOf) : null,
	replayedBy: t.replayedBy ?? null,
	replay: taskReplayEligibility(t),
	...requestLinks(t.requestId, t.receivedAt),
});

/** GET /observability/tasks */
export const handleListTasks = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query, TASK_LIST_SPEC);
		res.json(await runListQuery(TaskRunModel, parsed, { map: publicTask }));
	} catch (error) {
		answer(res, error, "listing task runs");
	}
};

/** GET /observability/tasks/stats?range= */
export const handleTaskStats = async (req: Request, res: Response) => {
	try {
		const window = parseRange(req.query.range, "7d");
		const stats = await failureSeries(TaskRunModel, { $in: ["$outcome", ["failed", "rejected"]] }, window, "task");
		res.json({ range: window.range, from: window.from, to: window.to, bucketMs: window.bucketMs, ...stats });
	} catch (error) {
		answer(res, error, "reading task statistics");
	}
};

/** GET /observability/tasks/:id : the run, other runs for the same booking and replays of it. */
export const handleGetTask = async (req: Request, res: Response) => {
	try {
		const run = await TaskRunModel.findById(req.params.id).lean();
		if (!run) return res.status(404).json({ message: "Task run not found." });
		const related = run.bookingId
			? await TaskRunModel.find({ bookingId: run.bookingId, _id: { $ne: run._id } })
					.sort({ receivedAt: -1 })
					.limit(20)
					.lean()
			: [];
		res.json({ task: publicTask(run), related: related.map(publicTask) });
	} catch (error) {
		answer(res, error, "reading a task run");
	}
};

/** POST /observability/tasks/:id/replay { confirm: true, reason } : runs the task handler again with the same booking. */
export const handleReplayTask = async (req: Request, res: Response) => {
	try {
		if (req.body.confirm !== true) {
			return res
				.status(400)
				.json({ message: "Replaying runs the task again. Send confirm: true to go ahead.", field: "confirm" });
		}
		const run = await TaskRunModel.findById(req.params.id).lean();
		if (!run) return res.status(404).json({ message: "Task run not found." });
		const eligibility = taskReplayEligibility(run);
		if (!eligibility.eligible) return res.status(409).json({ message: eligibility.reason });

		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const tasks = require("../webhook-controllers/cloudtasks.controller");
		const handler =
			run.task === "earning-complete"
				? tasks.handleGoogleCloudTasksEarningComplete
				: run.task === "booking-no-show"
					? tasks.handleGoogleCloudTasksBookingNoShow
					: tasks.handleGoogleCloudTasksBookingExpired;
		const started = new Date();
		const result = await new Promise<{ status: number; message: string | null }>((resolve) => {
			let status = 200;
			const fakeRes: any = {
				status(code: number) {
					status = code;
					return fakeRes;
				},
				json(body: any) {
					resolve({
						status,
						message: typeof body?.message === "string" ? body.message.slice(0, 1000) : null,
					});
					return fakeRes;
				},
			};
			const fakeReq: any = { body: { bookingId: run.bookingId }, headers: {}, context: req.context };
			const go = () =>
				Promise.resolve(handler(fakeReq, fakeRes)).catch((error: unknown) =>
					resolve({ status: 500, message: String((error as Error)?.message ?? error).slice(0, 1000) }),
				);
			if (req.context) runWithContext(req.context, go);
			else go();
		});
		const processedAt = new Date();
		const outcome = taskOutcomeFor(result.status, result.message);
		const created = await TaskRunModel.create({
			task: run.task,
			taskName: null,
			queue: "console-replay",
			retryCount: null,
			executionCount: null,
			bookingId: run.bookingId,
			receivedAt: started,
			processedAt,
			durationMs: processedAt.getTime() - started.getTime(),
			status: result.status,
			outcome,
			note: outcome === "failed" ? null : result.message,
			error: outcome === "failed" ? result.message : null,
			requestId: req.context?.requestId ?? null,
			replayOf: run._id,
			replayedBy: req.admin!.email,
		});
		await recordAudit(
			{
				action: "observability.task_replayed",
				actor: adminActor(req),
				target: { type: "task_run", id: String(run._id) },
				before: { outcome: run.outcome },
				after: { outcome, status: result.status, newRunId: String(created._id) },
				reason: req.body.reason ? String(req.body.reason) : null,
				metadata: { task: run.task, bookingId: run.bookingId },
			},
			req,
		);
		adminEvent(req, "observability.task_replayed", "task_run", { outcome });
		res.json({
			result: { outcome, status: result.status, message: result.message },
			task: publicTask(created.toObject()),
		});
	} catch (error) {
		answer(res, error, "replaying a task run");
	}
};

// --- Alerts -------------------------------------------------------------------------------------------------------

const publicAlert = (a: any) => ({
	id: String(a._id),
	ruleId: String(a.ruleId),
	ruleName: a.ruleName,
	kind: a.kind,
	severity: a.severity,
	status: a.status,
	firedAt: a.firedAt,
	acknowledgedAt: a.acknowledgedAt ?? null,
	acknowledgedBy: a.acknowledgedBy ?? null,
	resolvedAt: a.resolvedAt ?? null,
	resolvedBy: a.resolvedBy ?? null,
	value: a.value,
	lastValue: a.lastValue ?? null,
	threshold: a.threshold,
	summary: a.summary,
	notified: a.notified ?? null,
	history: a.history ?? [],
});

export const ALERT_LIST_SPEC: ListSpec = {
	sortable: { firedAt: "firedAt", severity: "severity" },
	defaultSort: "-firedAt",
	filters: {
		status: { type: "enum", path: "status", values: ["firing", "acknowledged", "resolved"] },
		severity: { type: "enum", path: "severity", values: ["warning", "critical"] },
		kind: { type: "enum", path: "kind", values: Object.keys(ALERT_KINDS) },
		ruleId: { type: "objectId", path: "ruleId" },
		open: {
			type: "custom",
			parse: (value) =>
				value === "true" ? { status: { $ne: "resolved" } } : value === "false" ? { status: "resolved" } : null,
		},
	},
	dateField: "firedAt",
	searchFields: ["ruleName", "summary"],
	maxPageSize: 100,
};

/** GET /observability/alerts */
export const handleListAlerts = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query, ALERT_LIST_SPEC);
		const [page, counts] = await Promise.all([
			runListQuery(AlertModel, parsed, { map: publicAlert }),
			AlertModel.aggregate([
				{ $match: { status: { $ne: "resolved" } } },
				{ $group: { _id: "$status", n: { $sum: 1 } } },
			]),
		]);
		res.json({ ...page, open: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
	} catch (error) {
		answer(res, error, "listing alerts");
	}
};

/** GET /observability/alerts/:id */
export const handleGetAlert = async (req: Request, res: Response) => {
	try {
		const alert = await AlertModel.findById(req.params.id).lean();
		if (!alert) return res.status(404).json({ message: "Alert not found." });
		const rule = await AlertRuleModel.findById(alert.ruleId).lean();
		res.json({ alert: publicAlert(alert), rule: rule ? publicRule(rule) : null });
	} catch (error) {
		answer(res, error, "reading an alert");
	}
};

const alertAction = (to: "acknowledged" | "resolved") => async (req: Request, res: Response) => {
	try {
		const alert = await AlertModel.findById(req.params.id).lean();
		if (!alert) return res.status(404).json({ message: "Alert not found." });
		const allowedFrom = to === "acknowledged" ? ["firing"] : ["firing", "acknowledged"];
		if (!allowedFrom.includes(alert.status))
			return res.status(409).json({ message: `This alert is ${alert.status}.` });
		const now = new Date();
		const by = { id: String(req.admin!._id), email: req.admin!.email };
		const note = req.body.reason ? String(req.body.reason).slice(0, 1000) : null;
		const updated = await AlertModel.findOneAndUpdate(
			{ _id: alert._id, status: alert.status },
			{
				$set:
					to === "acknowledged"
						? { status: to, acknowledgedAt: now, acknowledgedBy: by }
						: {
								status: to,
								resolvedAt: now,
								resolvedBy: by,
								expireAt: new Date(now.getTime() + retention().alerts),
							},
				$push: { history: { at: now, status: to, by: by.email, note } },
			},
			{ new: true },
		).lean();
		if (!updated) return res.status(409).json({ message: "This alert changed meanwhile. Reload it." });
		const action: AuditAction =
			to === "acknowledged" ? "observability.alert_acknowledged" : "observability.alert_resolved";
		await recordAudit(
			{
				action,
				actor: adminActor(req),
				target: { type: "alert", id: String(alert._id) },
				before: { status: alert.status },
				after: { status: to },
				reason: note,
				metadata: { rule: alert.ruleName },
			},
			req,
		);
		adminEvent(req, action, "alert");
		res.json({ alert: publicAlert(updated) });
	} catch (error) {
		answer(res, error, "changing an alert");
	}
};

export const handleAcknowledgeAlert = alertAction("acknowledged");
export const handleResolveAlert = alertAction("resolved");

// --- Alert rules --------------------------------------------------------------------------------------------------

const publicRule = (r: any) => ({
	id: String(r._id),
	key: r.key ?? null,
	name: r.name,
	kind: r.kind,
	enabled: r.enabled,
	threshold: r.threshold,
	minutes: r.minutes,
	percentile: r.percentile ?? null,
	minRequests: r.minRequests ?? null,
	route: r.route ?? null,
	dependency: r.dependency ?? null,
	newReleaseOnly: r.newReleaseOnly ?? null,
	severity: r.severity,
	recipients: r.recipients ?? [],
	cooldownMinutes: r.cooldownMinutes,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt,
	createdBy: r.createdBy ?? null,
	updatedBy: r.updatedBy ?? null,
	lastEvaluatedAt: r.lastEvaluatedAt ?? null,
	lastValue: r.lastValue ?? null,
	lastSummary: r.lastSummary ?? null,
});

const ruleFields = (rule: AlertRuleInput) => ({
	name: rule.name,
	kind: rule.kind,
	enabled: rule.enabled,
	threshold: rule.threshold,
	minutes: rule.minutes,
	percentile: rule.percentile ?? null,
	minRequests: rule.minRequests ?? null,
	route: rule.route ?? null,
	dependency: rule.dependency ?? null,
	newReleaseOnly: rule.newReleaseOnly ?? null,
	severity: rule.severity,
	recipients: rule.recipients,
	cooldownMinutes: rule.cooldownMinutes,
});

const ruleAsInput = (r: any): AlertRuleInput => ({
	name: r.name,
	kind: r.kind,
	enabled: r.enabled,
	threshold: r.threshold,
	minutes: r.minutes,
	percentile: r.percentile ?? undefined,
	minRequests: r.minRequests ?? undefined,
	route: r.route,
	dependency: r.dependency,
	newReleaseOnly: r.newReleaseOnly ?? undefined,
	severity: r.severity,
	recipients: r.recipients ?? [],
	cooldownMinutes: r.cooldownMinutes,
});

/** Recipients must be active admins who can read observability. */
const checkRecipients = async (ids: string[]) => {
	if (!ids.length) return;
	const admins = await AdminModel.find({ _id: { $in: ids } })
		.select("email role roles disabled")
		.lean();
	const ok = new Set(
		admins.filter((a: any) => !a.disabled && hasPermission(a, "observability.read")).map((a: any) => String(a._id)),
	);
	const bad = ids.filter((id) => !ok.has(id));
	if (bad.length)
		throw new RuleInputError("Every recipient must be an active admin who can read observability.", "recipients");
};

/** GET /observability/alert-rules */
export const handleListRules = async (_req: Request, res: Response) => {
	try {
		const rules = await AlertRuleModel.find({ deletedAt: null }).sort({ createdAt: 1 }).lean();
		const open = await AlertModel.aggregate([
			{ $match: { status: { $ne: "resolved" } } },
			{ $group: { _id: "$ruleId", n: { $sum: 1 } } },
		]);
		const openBy = new Map(open.map((o) => [String(o._id), o.n]));
		res.json({ items: rules.map((r) => ({ ...publicRule(r), openAlerts: openBy.get(String(r._id)) ?? 0 })) });
	} catch (error) {
		answer(res, error, "listing alert rules");
	}
};

/** GET /observability/alert-rules/:id */
export const handleGetRule = async (req: Request, res: Response) => {
	try {
		const rule = await AlertRuleModel.findOne({ _id: req.params.id, deletedAt: null }).lean();
		if (!rule) return res.status(404).json({ message: "Alert rule not found." });
		const recent = await AlertModel.find({ ruleId: rule._id }).sort({ firedAt: -1 }).limit(20).lean();
		res.json({ rule: publicRule(rule), alerts: recent.map(publicAlert) });
	} catch (error) {
		answer(res, error, "reading an alert rule");
	}
};

/** POST /observability/alert-rules */
export const handleCreateRule = async (req: Request, res: Response) => {
	try {
		const input = parseRuleInput(req.body);
		await checkRecipients(input.recipients);
		const now = new Date();
		const by = { id: String(req.admin!._id), email: req.admin!.email };
		const rule = await AlertRuleModel.create({
			...ruleFields(input),
			key: null,
			createdAt: now,
			updatedAt: now,
			createdBy: by,
			updatedBy: by,
		});
		await recordAudit(
			{
				action: "observability.alert_rule_created",
				actor: adminActor(req),
				target: { type: "alert_rule", id: String(rule._id) },
				after: ruleFields(input),
				reason: req.body.reason ? String(req.body.reason) : null,
			},
			req,
		);
		adminEvent(req, "observability.alert_rule_created", "alert_rule");
		res.status(201).json({ rule: publicRule(rule.toObject()) });
	} catch (error) {
		answer(res, error, "creating an alert rule");
	}
};

/** PATCH /observability/alert-rules/:id (any subset of the fields; kind cannot change) */
export const handleUpdateRule = async (req: Request, res: Response) => {
	try {
		const current = await AlertRuleModel.findOne({ _id: req.params.id, deletedAt: null }).lean();
		if (!current) return res.status(404).json({ message: "Alert rule not found." });
		const before = ruleAsInput(current);
		const input = parseRuleInput(req.body, before);
		await checkRecipients(input.recipients.filter((id) => !before.recipients.includes(id)));
		const updated = await AlertRuleModel.findOneAndUpdate(
			{ _id: current._id, updatedAt: current.updatedAt, deletedAt: null },
			{
				$set: {
					...ruleFields(input),
					updatedAt: new Date(),
					updatedBy: { id: String(req.admin!._id), email: req.admin!.email },
				},
			},
			{ new: true },
		).lean();
		if (!updated) return res.status(409).json({ message: "This rule changed meanwhile. Reload it." });
		await recordAudit(
			{
				action: "observability.alert_rule_updated",
				actor: adminActor(req),
				target: { type: "alert_rule", id: String(current._id) },
				before: ruleFields(before),
				after: ruleFields(input),
				reason: req.body.reason ? String(req.body.reason) : null,
			},
			req,
		);
		adminEvent(req, "observability.alert_rule_updated", "alert_rule", { enabled: input.enabled });
		res.json({ rule: publicRule(updated) });
	} catch (error) {
		answer(res, error, "changing an alert rule");
	}
};

/** DELETE /observability/alert-rules/:id { reason? } : kept, marked deleted; its open alerts are resolved. */
export const handleDeleteRule = async (req: Request, res: Response) => {
	try {
		const now = new Date();
		const rule = await AlertRuleModel.findOneAndUpdate(
			{ _id: req.params.id, deletedAt: null },
			{
				$set: {
					deletedAt: now,
					enabled: false,
					updatedAt: now,
					updatedBy: { id: String(req.admin!._id), email: req.admin!.email },
				},
			},
			{ new: false },
		).lean();
		if (!rule) return res.status(404).json({ message: "Alert rule not found." });
		await AlertModel.updateMany(
			{ ruleId: rule._id, status: { $ne: "resolved" } },
			{
				$set: {
					status: "resolved",
					resolvedAt: now,
					resolvedBy: { id: String(req.admin!._id), email: req.admin!.email },
					expireAt: new Date(now.getTime() + retention().alerts),
				},
				$push: { history: { at: now, status: "resolved", by: req.admin!.email, note: "rule deleted" } },
			},
		);
		await recordAudit(
			{
				action: "observability.alert_rule_deleted",
				actor: adminActor(req),
				target: { type: "alert_rule", id: String(rule._id) },
				before: ruleFields(ruleAsInput(rule)),
				reason: req.body?.reason ? String(req.body.reason) : null,
			},
			req,
		);
		adminEvent(req, "observability.alert_rule_deleted", "alert_rule");
		res.status(204).end();
	} catch (error) {
		answer(res, error, "deleting an alert rule");
	}
};

/**
 * GET /observability/alert-rules/preview?kind=&threshold=&minutes=&...&range=24h|7d : replays the rule over recent
 * per-minute data and says how often it would have fired.
 */
export const handlePreviewRule = async (req: Request, res: Response) => {
	try {
		const { range, ...ruleQuery } = req.query as Record<string, unknown>;
		const window = parseRange(range, "24h");
		if (window.range !== "24h" && window.range !== "7d" && window.range !== "6h") {
			throw new ListQueryError("range must be 6h, 24h or 7d.", "range");
		}
		const rule = parseRuleInput({ name: "Preview", ...ruleQuery });
		const from = window.from;
		const to = new Date(Math.min(window.to.getTime(), Math.floor(Date.now() / 60_000) * 60_000));
		const minuteCount = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
		const minutes: MinuteMeasures[] = Array.from({ length: minuteCount }, () => ({
			requests: 0,
			errors: 0,
			rateLimited: 0,
			webhookFailures: 0,
			taskFailures: 0,
			failedSignIns: 0,
			newErrorGroups: 0,
		}));
		const indexOf = (date: Date) => Math.floor((date.getTime() - from.getTime()) / 60_000);
		const bump = (dates: Date[], field: keyof MinuteMeasures) => {
			for (const date of dates) {
				const i = indexOf(new Date(date));
				if (i >= 0 && i < minuteCount) (minutes[i][field] as number)++;
			}
		};
		const times = async (model: mongoose.Model<any>, filter: Record<string, unknown>, field: string) =>
			(
				await model
					.find({ ...filter, [field]: { $gte: from, $lt: to } })
					.select(field)
					.limit(20_000)
					.maxTimeMS(5000)
					.lean()
			).map((d: any) => d[field]);
		switch (rule.kind) {
			case "error_rate":
			case "latency":
			case "rate_limited": {
				const byMinute = await minuteTotals({
					from,
					to,
					route: rule.kind === "rate_limited" ? null : rule.route,
				});
				for (const [t, totals] of byMinute) {
					const i = indexOf(new Date(t));
					if (i < 0 || i >= minuteCount) continue;
					Object.assign(minutes[i], {
						requests: totals.n,
						errors: totals.s5,
						rateLimited: totals.rl,
						histogram: totals.h,
						maxMs: totals.max,
					});
				}
				break;
			}
			case "webhook_failures":
				bump(await times(WebhookEventModel, { outcome: "failed" }, "receivedAt"), "webhookFailures");
				break;
			case "task_failures":
				bump(
					await times(TaskRunModel, { outcome: { $in: ["failed", "rejected"] } }, "receivedAt"),
					"taskFailures",
				);
				break;
			case "failed_sign_ins":
				bump(await times(EventModel, { type: "auth.sign_in_failed" }, "at"), "failedSignIns");
				bump(await times(AuditLogModel, { action: "auth.login.failed" }, "at"), "failedSignIns");
				break;
			case "new_error_group":
				bump(await times(ErrorGroupModel, {}, "firstSeenAt"), "newErrorGroups");
				break;
			case "dependency_down": {
				const checks = await DependencyCheckModel.find({
					at: { $gte: from, $lt: to },
					...(rule.dependency ? { name: rule.dependency } : {}),
				})
					.select("name status at")
					.sort({ at: 1 })
					.lean();
				for (const check of checks) {
					const i = indexOf(check.at);
					if (i < 0 || i >= minuteCount) continue;
					minutes[i].down = { ...(minutes[i].down ?? {}), [check.name]: check.status === "down" };
				}
				break;
			}
		}
		const simulation = simulateRule(rule, minutes);
		const at = (i: number | null) => (i === null ? null : new Date(from.getTime() + i * 60_000));
		const hasData = minutes.some(
			(m) => m.requests || m.webhookFailures || m.taskFailures || m.failedSignIns || m.newErrorGroups || m.down,
		);
		res.json({
			range: window.range,
			from,
			to,
			hasData,
			evaluatedMinutes: simulation.evaluatedMinutes,
			firingMinutes: simulation.firingMinutes,
			wouldHaveFired: simulation.episodes,
			firstFiredAt: at(simulation.firstFiredAt),
			lastFiredAt: at(simulation.lastFiredAt),
			firedAt: simulation.openedAt.slice(0, 50).map(at),
			note:
				rule.kind === "new_error_group" && rule.newReleaseOnly
					? "The preview counts every new error group; the live rule counts only those first seen in the newest release."
					: null,
		});
	} catch (error) {
		answer(res, error, "previewing an alert rule");
	}
};

// --- Metadata -----------------------------------------------------------------------------------------------------

/** GET /observability/meta : rule kinds, dependency names, the serving revision and (managers) possible recipients. */
export const handleMeta = async (req: Request, res: Response) => {
	try {
		const canManage = hasPermission(req.admin as any, "observability.manage");
		const recipients = canManage
			? (
					await AdminModel.find({ disabled: { $ne: true } })
						.select("firstName lastName email role roles")
						.lean()
				)
					.filter((a: any) => hasPermission(a, "observability.read"))
					.map((a: any) => ({
						id: String(a._id),
						name: `${a.firstName} ${a.lastName}`.trim(),
						email: a.email,
					}))
			: [];
		res.json({
			revision: revision(),
			kinds: ALERT_KINDS,
			dependencies: DEPENDENCIES.map((d) => ({ name: d.name, label: d.label, configured: d.enabled() })),
			replayableWebhookTypes: REPLAYABLE_STRIPE_TYPES,
			replayableTasks: REPLAYABLE_TASKS,
			recipients,
			retentionDays: Object.fromEntries(
				Object.entries(retention()).map(([k, ms]) => [k, Math.round(ms / (24 * HOUR))]),
			),
		});
	} catch (error) {
		answer(res, error, "reading observability settings");
	}
};

// --- Client error ingestion (public) ------------------------------------------------------------------------------

const PLATFORMS = ["web", "ios", "android", "admin"];
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
const DEVICE = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/;
const ALLOWED_FIELDS = new Set([
	"message",
	"stack",
	"type",
	"route",
	"screen",
	"platform",
	"appVersion",
	"deviceId",
	"userAgent",
	"release",
	"handled",
]);

export class ClientReportError extends Error {}

/** Validates and normalises one client report. Pure; throws ClientReportError (answer 400). */
export const parseClientReport = (body: unknown) => {
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new ClientReportError("Send one error report as a JSON object.");
	const input = body as Record<string, unknown>;
	for (const key of Object.keys(input))
		if (!ALLOWED_FIELDS.has(key)) throw new ClientReportError(`Unknown field ${key}.`);
	const str = (key: string, max: number) => {
		const value = input[key];
		if (value === undefined || value === null || value === "") return null;
		if (typeof value !== "string") throw new ClientReportError(`${key} must be text.`);
		return value.slice(0, max);
	};
	const message = str("message", 2000);
	if (!message) throw new ClientReportError("message is required.");
	const platform = str("platform", 20)?.toLowerCase();
	if (!platform || !PLATFORMS.includes(platform))
		throw new ClientReportError(`platform must be one of: ${PLATFORMS.join(", ")}.`);
	const appVersion = str("appVersion", 32);
	if (appVersion && !VERSION.test(appVersion)) throw new ClientReportError("appVersion is not a version.");
	const deviceId = str("deviceId", 128);
	if (deviceId && !DEVICE.test(deviceId)) throw new ClientReportError("deviceId has unexpected characters.");
	if (input.handled !== undefined && typeof input.handled !== "boolean")
		throw new ClientReportError("handled must be true or false.");
	return {
		message,
		stack: str("stack", 16_000),
		type: str("type", 80),
		route: str("route", 300) ?? str("screen", 300),
		platform,
		appVersion,
		deviceId,
		userAgent: str("userAgent", 300),
	};
};

/** The signed-in user or admin from a bearer token, if one is sent and valid (signature only, then one lookup). */
const reporterOf = async (req: Request): Promise<{ userId?: string; adminId?: string }> => {
	const header = req.headers.authorization;
	if (!header?.startsWith("Bearer ") || header.length > 4200) return {};
	const token = header.slice(7);
	try {
		const admin = jwt.verify(token, adminTokenSecret(), {
			algorithms: ["HS256"],
			audience: ADMIN_TOKEN_AUDIENCE,
		}) as any;
		if (typeof admin?.sub === "string" && isObjectId(admin.sub)) return { adminId: admin.sub };
	} catch {
		// Not an admin token.
	}
	try {
		const user = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET || "", { algorithms: ["HS256"] }) as any;
		const email = user?.UserInfo?.email;
		if (typeof email !== "string") return {};
		const found = await UserModel.findOne({ email }).select("_id").maxTimeMS(1000).lean();
		return found ? { userId: String(found._id) } : {};
	} catch {
		return {};
	}
};

/** POST /client-errors : one JavaScript error report from the web app, the mobile app or the console. Always 202. */
export const handleClientError = async (req: Request, res: Response) => {
	try {
		const report = parseClientReport(req.body);
		const who = await reporterOf(req);
		const fingerprint = captureError({
			source: "client",
			platform: report.platform,
			type: report.type,
			message: report.message,
			stack: report.stack,
			route: report.route,
			appVersion: report.appVersion ?? req.context?.appVersion ?? null,
			deviceId: report.deviceId ?? req.context?.deviceId ?? null,
			userAgent: report.userAgent ?? (req.context?.userAgent ? scrubText(req.context.userAgent, 300) : null),
			requestId: req.context?.requestId ?? null,
			userId: who.userId ?? null,
			adminId: who.adminId ?? null,
		});
		res.status(202).json({ accepted: true, id: fingerprint });
	} catch (error) {
		if (error instanceof ClientReportError) return res.status(400).json({ message: error.message });
		log.warn("client_error_report_failed", "Observability: could not take a client error report", {
			reason: (error as Error)?.message,
		});
		res.status(202).json({ accepted: false });
	}
};
