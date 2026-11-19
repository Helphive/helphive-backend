// Finance, support and platform routes, registered on the admin router (routes/admin.route.ts) after its demo-admin
// limiter, read-only guard and response masking. Every route runs verifyAdminJWT then requirePermission; every write
// is marked with the audit actions it records (tests/adminRoutes.test.ts checks both) and every route here also has
// its own per-admin limit on top of the global one.
import type { Request, Router } from "express";
import { verifyAdminJWT } from "../middleware/verifyAdminJWT";
import { requirePermission } from "../middleware/requirePermission";
import { audited } from "../middleware/audited";
import { createLimiter } from "../middleware/rateLimit";
import type { Permission } from "../config/adminPermissions";
import {
	handleExplainMismatch,
	handleGetRun,
	handleListRuns,
	handleMoneySummary,
	handleRunReconciliation,
} from "../controllers/admin/finance.controller";
import { handleGetDispute, handleListDisputes } from "../controllers/admin/disputes.controller";
import { handleGetSettings, handleUpdateSetting } from "../controllers/admin/settings.controller";
import {
	handleAddCaseNote,
	handleGetCase,
	handleLinkCaseAction,
	handleListAssignees,
	handleListCases,
	handleOpenCase,
	handleResolveCase,
	handleSendCaseMessage,
	handleUpdateCase,
} from "../controllers/admin/supportCases.controller";
import {
	handleCreateTemplate,
	handleDeleteTemplate,
	handleGetCampaign,
	handleListCampaigns,
	handleListTemplates,
	handlePreview,
	handleSend,
	handleUpdateTemplate,
} from "../controllers/admin/notifications.controller";
import {
	mongoIdParam,
	validateCaseAction,
	validateCaseMessage,
	validateCaseNote,
	validateExplainMismatch,
	validateOpenCase,
	validateResolveCase,
	validateRunReconciliation,
	validateSendAnnouncement,
	validateTemplateBody,
	validateUpdateCase,
	validateUpdateSetting,
} from "../controllers/admin/finance.validators";

const MINUTE = 60 * 1000;

const perAdmin = (name: string, windowMs: number, limit: number) =>
	createLimiter({
		name,
		rule: { windowMs, limit },
		kind: "local",
		key: (req: Request) => (req.admin ? `${name}:${String(req.admin._id)}` : null),
	});

/** Reads: generous, bounds a runaway tab. */
export const financeReadLimiter = perAdmin("admin-finance-read", MINUTE, 120);
/** Ordinary writes (notes, case changes, settings, templates, explanations). */
export const financeWriteLimiter = perAdmin("admin-finance-write", MINUTE, 30);
/** Reconciliation runs read a lot from Stripe. */
export const reconciliationRunLimiter = perAdmin("admin-reconciliation-run", 10 * MINUTE, 5);
/** Emails to customers from cases. */
export const caseMessageLimiter = perAdmin("admin-case-message", 10 * MINUTE, 20);
/** Announcement sends (each may reach thousands of people). */
export const announcementSendLimiter = perAdmin("admin-announcement-send", 60 * MINUTE, 5);
/** Previews check email addresses against the email policy (DNS). */
export const announcementPreviewLimiter = perAdmin("admin-announcement-preview", MINUTE, 20);

const read = (permission: Permission) => [verifyAdminJWT, requirePermission(permission), financeReadLimiter];
const write = (permission: Permission, limiter = financeWriteLimiter) => [
	verifyAdminJWT,
	requirePermission(permission),
	limiter,
];

export const registerFinanceRoutes = (router: Router) => {
	// Reconciliation with Stripe and the money summary.
	router.get("/finance/summary", ...read("payments.read"), handleMoneySummary);
	router.get("/finance/reconciliation/runs", ...read("payments.read"), handleListRuns);
	router.post(
		"/finance/reconciliation/runs",
		...write("finance.manage", reconciliationRunLimiter),
		...validateRunReconciliation,
		audited(["finance.reconciliation_run"], handleRunReconciliation),
	);
	router.get(
		"/finance/reconciliation/runs/:id",
		...read("payments.read"),
		...mongoIdParam("id", "run"),
		handleGetRun,
	);
	router.post(
		"/finance/reconciliation/runs/:id/mismatches/:mismatchId/explain",
		...write("finance.manage"),
		...mongoIdParam("id", "run"),
		...validateExplainMismatch,
		audited(["finance.mismatch_explained"], handleExplainMismatch),
	);

	// Card disputes (recorded from Stripe webhooks; responded to in Stripe).
	router.get("/disputes", ...read("payments.read"), handleListDisputes);
	router.get("/disputes/:id", ...read("payments.read"), handleGetDispute);

	// Platform settings: every role reads them; only settings.manage changes them.
	router.get("/settings", ...read("account.self"), handleGetSettings);
	router.patch(
		"/settings/:key",
		...write("settings.manage"),
		...validateUpdateSetting,
		audited(["settings.updated"], handleUpdateSetting),
	);

	// Support cases.
	router.get("/cases", ...read("support.read"), handleListCases);
	router.get("/cases/assignees", ...read("support.read"), handleListAssignees);
	router.post(
		"/cases",
		...write("support.manage"),
		...validateOpenCase,
		audited(["support.case_opened"], handleOpenCase),
	);
	router.get("/cases/:id", ...read("support.read"), ...mongoIdParam("id", "case"), handleGetCase);
	router.patch(
		"/cases/:id",
		...write("support.manage"),
		...mongoIdParam("id", "case"),
		...validateUpdateCase,
		audited(["support.case_updated"], handleUpdateCase),
	);
	router.post(
		"/cases/:id/notes",
		...write("support.manage"),
		...mongoIdParam("id", "case"),
		...validateCaseNote,
		audited(["support.case_note_added"], handleAddCaseNote),
	);
	router.post(
		"/cases/:id/messages",
		...write("support.manage", caseMessageLimiter),
		...mongoIdParam("id", "case"),
		...validateCaseMessage,
		audited(["support.case_message_sent"], handleSendCaseMessage),
	);
	router.post(
		"/cases/:id/actions",
		...write("support.manage"),
		...mongoIdParam("id", "case"),
		...validateCaseAction,
		audited(["support.case_action_linked"], handleLinkCaseAction),
	);
	router.post(
		"/cases/:id/resolve",
		...write("support.manage"),
		...mongoIdParam("id", "case"),
		...validateResolveCase,
		audited(["support.case_resolved"], handleResolveCase),
	);

	// Notifications centre.
	router.get(
		"/notifications/preview",
		verifyAdminJWT,
		requirePermission("support.read"),
		announcementPreviewLimiter,
		handlePreview,
	);
	router.post(
		"/notifications/send",
		...write("notifications.send", announcementSendLimiter),
		...validateSendAnnouncement,
		audited(["notifications.sent"], handleSend),
	);
	router.get("/notifications/campaigns", ...read("support.read"), handleListCampaigns);
	router.get(
		"/notifications/campaigns/:id",
		...read("support.read"),
		...mongoIdParam("id", "announcement"),
		handleGetCampaign,
	);
	router.get("/notifications/templates", ...read("support.read"), handleListTemplates);
	router.post(
		"/notifications/templates",
		...write("notifications.send"),
		...validateTemplateBody,
		audited(["notifications.template_saved"], handleCreateTemplate),
	);
	router.patch(
		"/notifications/templates/:id",
		...write("notifications.send"),
		...mongoIdParam("id", "template"),
		...validateTemplateBody,
		audited(["notifications.template_saved"], handleUpdateTemplate),
	);
	router.delete(
		"/notifications/templates/:id",
		...write("notifications.send"),
		...mongoIdParam("id", "template"),
		audited(["notifications.template_deleted"], handleDeleteTemplate),
	);
};
