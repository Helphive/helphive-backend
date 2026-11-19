// The finance, support and platform routes: each exists with its permission, after the demo guard and masking, with a
// per-admin rate limit after authentication; the new permissions are granted as intended. No server, no database.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

delete process.env.DATABASE_URI;
mongoose.set("bufferCommands", false);
process.env.STRIPE_SECRET_KEY = "sk_test_wiring_only";

/* eslint-disable @typescript-eslint/no-require-imports */
const adminRoute = require("../routes/admin.route").default;
const publicRoute = require("../routes/public.route").default;
const finance = require("../routes/adminFinance.route");
const { auditActionsOf } = require("../middleware/audited");
const { ROLE_PERMISSIONS, PERMISSIONS } = require("../config/adminPermissions");
/* eslint-enable @typescript-eslint/no-require-imports */

const ROUTES: [string, string, string][] = [
	["GET", "/finance/summary", "payments.read"],
	["GET", "/finance/reconciliation/runs", "payments.read"],
	["POST", "/finance/reconciliation/runs", "finance.manage"],
	["GET", "/finance/reconciliation/runs/:id", "payments.read"],
	["POST", "/finance/reconciliation/runs/:id/mismatches/:mismatchId/explain", "finance.manage"],
	["GET", "/disputes", "payments.read"],
	["GET", "/disputes/:id", "payments.read"],
	["GET", "/settings", "account.self"],
	["PATCH", "/settings/:key", "settings.manage"],
	["GET", "/cases", "support.read"],
	["GET", "/cases/assignees", "support.read"],
	["POST", "/cases", "support.manage"],
	["GET", "/cases/:id", "support.read"],
	["PATCH", "/cases/:id", "support.manage"],
	["POST", "/cases/:id/notes", "support.manage"],
	["POST", "/cases/:id/messages", "support.manage"],
	["POST", "/cases/:id/actions", "support.manage"],
	["POST", "/cases/:id/resolve", "support.manage"],
	["GET", "/notifications/preview", "support.read"],
	["POST", "/notifications/send", "notifications.send"],
	["GET", "/notifications/campaigns", "support.read"],
	["GET", "/notifications/campaigns/:id", "support.read"],
	["GET", "/notifications/templates", "support.read"],
	["POST", "/notifications/templates", "notifications.send"],
	["PATCH", "/notifications/templates/:id", "notifications.send"],
	["DELETE", "/notifications/templates/:id", "notifications.send"],
];

const LIMITERS = new Set([
	finance.financeReadLimiter,
	finance.financeWriteLimiter,
	finance.reconciliationRunLimiter,
	finance.caseMessageLimiter,
	finance.announcementSendLimiter,
	finance.announcementPreviewLimiter,
]);

test("every route exists with its permission, a per-admin limit after it, after the demo middleware; writes are audited", () => {
	const stack = adminRoute.stack as any[];
	for (const [method, path, permission] of ROUTES) {
		const index = stack.findIndex((l) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
		assert.ok(index >= 3, `${method} ${path} exists after the demo middleware`);
		const handles = stack[index].route.stack.map((s: any) => s.handle);
		const permissionAt = handles.findIndex((h: any) => h.permission);
		assert.equal(handles[permissionAt].permission, permission, `${method} ${path}`);
		const limiterAt = handles.findIndex((h: any) => LIMITERS.has(h));
		assert.ok(limiterAt > permissionAt, `${method} ${path} is rate limited per admin`);
		if (method !== "GET")
			assert.ok(auditActionsOf(handles[handles.length - 1])?.length, `${method} ${path} is audited`);
	}
	const assignees = stack.findIndex((l) => l.route?.path === "/cases/assignees");
	const caseById = stack.findIndex((l) => l.route?.path === "/cases/:id" && l.route.methods.get);
	assert.ok(assignees < caseById, "/cases/assignees is matched before /cases/:id");
});

test("public routes: the announcement and the services, read only", () => {
	const routes = (publicRoute.stack as any[])
		.filter((l) => l.route)
		.map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
	assert.deepEqual(routes.sort(), ["get /announcement", "get /services"]);
});

test("new permissions: finance.manage for finance; notifications.send for operations and support; read-only roles get neither", () => {
	assert.ok("finance.manage" in PERMISSIONS && "notifications.send" in PERMISSIONS);
	assert.ok(ROLE_PERMISSIONS.finance.includes("finance.manage"));
	assert.ok(
		ROLE_PERMISSIONS.superAdmin.includes("finance.manage") &&
			ROLE_PERMISSIONS.superAdmin.includes("notifications.send"),
	);
	assert.ok(ROLE_PERMISSIONS.operations.includes("notifications.send"));
	assert.ok(ROLE_PERMISSIONS.support.includes("notifications.send"));
	for (const role of ["analyst", "demo"]) {
		assert.equal(ROLE_PERMISSIONS[role].includes("finance.manage"), false, role);
		assert.equal(ROLE_PERMISSIONS[role].includes("notifications.send"), false, role);
	}
	for (const role of Object.keys(ROLE_PERMISSIONS))
		assert.ok(ROLE_PERMISSIONS[role].includes("account.self"), `${role} reads settings`);
});
