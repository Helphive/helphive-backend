// The observability console routes under /admin/observability, registered on the admin router after its demo
// limiter, read-only guard and response masking. Every route runs verifyAdminJWT, requirePermission, a per-admin rate
// limit and validation; every write is audited (tests/adminRoutes.test.ts) and emits admin.action_taken.
import type { NextFunction, Request, Response, Router } from "express";
import { body } from "express-validator";
import { verifyAdminJWT } from "../middleware/verifyAdminJWT";
import { requirePermission } from "../middleware/requirePermission";
import { audited } from "../middleware/audited";
import { createLimiter } from "../middleware/rateLimit";
import type { Permission } from "../config/adminPermissions";
import { idParam } from "../controllers/admin/operations.validators";
import { rejectIfInvalid } from "../controllers/user-controllers/validators/common.validators";
import {
	handleDependencies,
	handleDependencyHistory,
	handleErrorFacets,
	handleGetError,
	handleGetRelease,
	handleListErrors,
	handleListReleases,
	handleLogs,
	handleOverview,
	handleRequestSummary,
	handleRouteTable,
	handleSetErrorStatus,
	handleTopRoutes,
} from "../controllers/admin/observability.controller";
import {
	handleAcknowledgeAlert,
	handleCreateRule,
	handleDeleteRule,
	handleGetAlert,
	handleGetRule,
	handleGetTask,
	handleGetWebhook,
	handleListAlerts,
	handleListRules,
	handleListTasks,
	handleListWebhooks,
	handleMeta,
	handlePreviewRule,
	handleReplayTask,
	handleReplayWebhook,
	handleResolveAlert,
	handleTaskStats,
	handleUpdateRule,
	handleWebhookStats,
} from "../controllers/admin/observabilityOps.controller";

const MINUTE = 60_000;

const perAdmin = (name: string, limit: number, windowMs = MINUTE) =>
	createLimiter({
		name,
		rule: { windowMs, limit },
		kind: "local",
		key: (req) => {
			const admin = (req as Request & { admin?: { _id: unknown } }).admin;
			return admin ? `${name}:${String(admin._id)}` : null;
		},
	});

// Reads: dashboards fire several calls per page and refetch on focus. Logs: Cloud Logging allows 60 reads a minute
// per project, shared by everyone. Fresh dependency checks call seven services. Writes and replays: a person's pace.
export const observabilityReadLimiter = perAdmin("obs-read", 240);
export const observabilityLogsLimiter = perAdmin("obs-logs", 20);
export const observabilityCheckLimiter = perAdmin("obs-dependency-check", 6);
export const observabilityWriteLimiter = perAdmin("obs-write", 30);
export const observabilityReplayLimiter = perAdmin("obs-replay", 10, 10 * MINUTE);

const read = (permission: Permission = "observability.read") => [
	verifyAdminJWT,
	requirePermission(permission),
	observabilityReadLimiter,
];
const write = [verifyAdminJWT, requirePermission("observability.manage"), observabilityWriteLimiter];

const optionalReason = body("reason")
	.optional({ values: "falsy" })
	.isString()
	.withMessage("Reason must be text.")
	.trim()
	.isLength({ max: 1000 })
	.withMessage("Reason must be at most 1000 characters.");

/** GET routes take no body; refuse one so nothing hides there. Query strings are validated by each handler. */
const noBody = (req: Request, res: Response, next: NextFunction) =>
	req.body && typeof req.body === "object" && Object.keys(req.body).length
		? res.status(400).json({ message: "This request takes no body." })
		: next();

const freshCheck = (req: Request, res: Response, next: NextFunction) =>
	req.query.fresh === "true" ? observabilityCheckLimiter(req, res, next) : next();

const revisionParam = (req: Request, res: Response, next: NextFunction) =>
	/^[A-Za-z0-9._-]{1,100}$/.test(req.params.revision)
		? next()
		: res.status(400).json({ message: "Invalid revision." });

const confirmed = [
	body("confirm")
		.custom((value) => value === true)
		.withMessage("Send confirm: true to replay."),
	optionalReason,
	rejectIfInvalid,
];

export const registerObservabilityRoutes = (router: Router) => {
	const base = "/observability";

	router.get(`${base}/meta`, ...read(), noBody, handleMeta);
	router.get(`${base}/overview`, ...read(), noBody, handleOverview);

	// Requests.
	router.get(`${base}/requests/summary`, ...read(), noBody, handleRequestSummary);
	router.get(`${base}/requests/routes`, ...read(), noBody, handleRouteTable);
	router.get(`${base}/requests/top`, ...read(), noBody, handleTopRoutes);

	// Errors (server and client).
	router.get(`${base}/errors`, ...read(), noBody, handleListErrors);
	router.get(`${base}/errors/facets`, ...read(), noBody, handleErrorFacets);
	router.get(`${base}/errors/:id`, ...read(), idParam("error group"), handleGetError);
	router.post(
		`${base}/errors/:id/status`,
		...write,
		idParam("error group"),
		body("status")
			.isIn(["resolved", "ignored", "unresolved"])
			.withMessage("status must be resolved, ignored or unresolved."),
		optionalReason,
		rejectIfInvalid,
		audited(["observability.error_status_changed"], handleSetErrorStatus),
	);

	// Logs (Cloud Logging).
	router.get(
		`${base}/logs`,
		verifyAdminJWT,
		requirePermission("observability.read"),
		observabilityLogsLimiter,
		noBody,
		handleLogs,
	);

	// Webhooks and background tasks.
	router.get(`${base}/webhooks`, ...read(), noBody, handleListWebhooks);
	router.get(`${base}/webhooks/stats`, ...read(), noBody, handleWebhookStats);
	router.get(`${base}/webhooks/:id`, ...read(), idParam("webhook event"), handleGetWebhook);
	router.post(
		`${base}/webhooks/:id/replay`,
		...write,
		observabilityReplayLimiter,
		idParam("webhook event"),
		...confirmed,
		audited(["observability.webhook_replayed"], handleReplayWebhook),
	);
	router.get(`${base}/tasks`, ...read(), noBody, handleListTasks);
	router.get(`${base}/tasks/stats`, ...read(), noBody, handleTaskStats);
	router.get(`${base}/tasks/:id`, ...read(), idParam("task run"), handleGetTask);
	router.post(
		`${base}/tasks/:id/replay`,
		...write,
		observabilityReplayLimiter,
		idParam("task run"),
		...confirmed,
		audited(["observability.task_replayed"], handleReplayTask),
	);

	// Dependencies and releases.
	router.get(`${base}/dependencies`, ...read(), freshCheck, noBody, handleDependencies);
	router.get(`${base}/dependencies/history`, ...read(), noBody, handleDependencyHistory);
	router.get(`${base}/releases`, ...read(), noBody, handleListReleases);
	router.get(`${base}/releases/:revision`, ...read(), revisionParam, handleGetRelease);

	// Alerts and rules.
	router.get(`${base}/alerts`, ...read(), noBody, handleListAlerts);
	router.get(`${base}/alerts/:id`, ...read(), idParam("alert"), handleGetAlert);
	router.post(
		`${base}/alerts/:id/acknowledge`,
		...write,
		idParam("alert"),
		optionalReason,
		rejectIfInvalid,
		audited(["observability.alert_acknowledged"], handleAcknowledgeAlert),
	);
	router.post(
		`${base}/alerts/:id/resolve`,
		...write,
		idParam("alert"),
		optionalReason,
		rejectIfInvalid,
		audited(["observability.alert_resolved"], handleResolveAlert),
	);
	router.get(`${base}/alert-rules`, ...read(), noBody, handleListRules);
	router.get(`${base}/alert-rules/preview`, ...read(), noBody, handlePreviewRule);
	router.get(`${base}/alert-rules/:id`, ...read(), idParam("alert rule"), handleGetRule);
	// Rule bodies are validated field by field in parseRuleInput (400 { message, field }).
	router.post(`${base}/alert-rules`, ...write, audited(["observability.alert_rule_created"], handleCreateRule));
	router.patch(
		`${base}/alert-rules/:id`,
		...write,
		idParam("alert rule"),
		audited(["observability.alert_rule_updated"], handleUpdateRule),
	);
	router.delete(
		`${base}/alert-rules/:id`,
		...write,
		idParam("alert rule"),
		optionalReason,
		rejectIfInvalid,
		audited(["observability.alert_rule_deleted"], handleDeleteRule),
	);
};
