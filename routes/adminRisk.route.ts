// Fraud and risk routes under /admin/risk, registered on the admin router (routes/admin.route.ts) after its
// demo-admin limiter, read-only guard and response masking. Every route runs verifyAdminJWT then requirePermission
// (risk.read for reads, risk.manage for changes), then a per-admin rate limit; every write route is marked with the
// audit actions it records. Registering the routes also starts the risk engine (lib/risk/engine.ts).
import type { Request, Router } from "express";
import { verifyAdminJWT } from "../middleware/verifyAdminJWT";
import { requirePermission } from "../middleware/requirePermission";
import { audited } from "../middleware/audited";
import { createLimiter } from "../middleware/rateLimit";
import type { Permission } from "../config/adminPermissions";
import { startRiskEngine } from "../lib/risk/engine";
import { validateRefund } from "../controllers/admin/operations.validators";
import * as risk from "../controllers/admin/risk.controller";
import {
	riskIdParam,
	validateAssign,
	validateCaseBlock,
	validateCaseNote,
	validateCaseRefund,
	validateCaseStatus,
	validateDecision,
	validateHold,
	validateListEntry,
	validateListExpiry,
	validateOpenCase,
	validatePlaceHold,
	validateRiskReason,
} from "../controllers/admin/risk.validators";

const adminKey = (prefix: string) => (req: Request) => {
	const admin = (req as Request & { admin?: { _id: unknown } }).admin;
	return admin ? `${prefix}:${String(admin._id)}` : null;
};

/** Reads: 120 a minute per admin (per instance). */
export const riskReadLimiter = createLimiter({
	name: "admin-risk-read",
	rule: { windowMs: 60_000, limit: 120 },
	kind: "local",
	key: adminKey("risk-read"),
});
/** Writes: 30 a minute per admin. */
export const riskWriteLimiter = createLimiter({
	name: "admin-risk-write",
	rule: { windowMs: 60_000, limit: 30 },
	kind: "local",
	key: adminKey("risk-write"),
});
/** Backtests and graphs load many records: 6 a minute per admin. */
export const riskHeavyLimiter = createLimiter({
	name: "admin-risk-heavy",
	rule: { windowMs: 60_000, limit: 6 },
	kind: "local",
	key: adminKey("risk-heavy"),
});

const read = (permission: Permission = "risk.read") => [verifyAdminJWT, requirePermission(permission), riskReadLimiter];
const write = () => [verifyAdminJWT, requirePermission("risk.manage"), riskWriteLimiter];
const heavy = () => [verifyAdminJWT, requirePermission("risk.read"), riskHeavyLimiter];

export const registerRiskRoutes = (router: Router) => {
	startRiskEngine();

	router.get("/risk/overview", ...read(), risk.handleRiskOverview);
	router.get("/risk/signals", ...read(), risk.handleListSignals);

	// Rules and backtests.
	router.get("/risk/rules", ...read(), risk.handleListRules);
	router.get("/risk/rules/:id", ...read(), ...riskIdParam("rule"), risk.handleGetRule);
	router.post("/risk/rules", ...write(), audited(["risk.rule_created"], risk.handleCreateRule));
	router.patch(
		"/risk/rules/:id",
		...write(),
		...riskIdParam("rule"),
		audited(["risk.rule_updated"], risk.handleUpdateRule),
	);
	router.get("/risk/backtest", ...heavy(), risk.handleBacktest);

	// A person's risk: the explained score (panel) and linked accounts.
	router.get("/risk/users/:id", ...read(), ...riskIdParam("user"), risk.handleGetUserRisk);
	router.get("/risk/users/:id/graph", ...heavy(), ...riskIdParam("user"), risk.handleUserGraph);

	// Review cases.
	router.get("/risk/cases", ...read(), risk.handleListCases);
	router.post("/risk/cases", ...write(), ...validateOpenCase, audited(["risk.case_opened"], risk.handleOpenCase));
	router.get("/risk/cases/:id", ...read(), ...riskIdParam("case"), risk.handleGetCase);
	const caseAction = (path: string, actions: Parameters<typeof audited>[0], validators: any[], handler: any) =>
		router.post(
			`/risk/cases/:id/${path}`,
			...write(),
			...riskIdParam("case"),
			...validators,
			audited(actions, handler),
		);
	caseAction("assign", ["risk.case_updated"], validateAssign, risk.handleAssignCase);
	caseAction("status", ["risk.case_updated"], validateCaseStatus, risk.handleCaseStatus);
	caseAction("notes", ["risk.case_updated"], validateCaseNote, risk.handleCaseNote);
	caseAction("decide", ["risk.case_decided"], validateDecision, risk.handleDecideCase);
	caseAction("hold", ["risk.hold_placed"], validateHold, risk.handleCaseHold);
	caseAction("release-holds", ["risk.hold_released"], validateRiskReason, risk.handleCaseReleaseHolds);
	caseAction("suspend", ["users.suspended"], validateRiskReason, risk.handleCaseSuspend);
	caseAction("reinstate", ["users.reinstated"], validateRiskReason, risk.handleCaseReinstate);
	caseAction("refund", ["payments.refunded"], [...validateCaseRefund, ...validateRefund], risk.handleCaseRefund);
	caseAction("block", ["risk.list_entry_added"], validateCaseBlock, risk.handleCaseBlock);

	// Payout holds.
	router.get("/risk/holds", ...read(), risk.handleListHolds);
	router.post("/risk/holds", ...write(), ...validatePlaceHold, audited(["risk.hold_placed"], risk.handlePlaceHold));
	router.post(
		"/risk/holds/:id/release",
		...write(),
		...riskIdParam("hold"),
		...validateRiskReason,
		audited(["risk.hold_released"], risk.handleReleaseHold),
	);

	// Block and allow lists.
	router.get("/risk/lists", ...read(), risk.handleListEntries);
	router.post(
		"/risk/lists",
		...write(),
		...validateListEntry,
		audited(["risk.list_entry_added"], risk.handleAddListEntry),
	);
	router.patch(
		"/risk/lists/:id",
		...write(),
		...riskIdParam("list entry"),
		...validateListExpiry,
		audited(["risk.list_entry_updated"], risk.handleUpdateListEntry),
	);
	router.delete(
		"/risk/lists/:id",
		...write(),
		...riskIdParam("list entry"),
		...validateRiskReason,
		audited(["risk.list_entry_removed"], risk.handleRemoveListEntry),
	);
};
