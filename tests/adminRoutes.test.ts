// Run with: npx ts-node tests/adminRoutes.test.ts
// Loads every route module (no server, no database) and checks the wiring: each module is a router, the routes the
// current admin console uses still exist, and every admin route is guarded by verifyAdminJWT + requirePermission
// except the four that authenticate otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";

// Never reach a database from here, whatever .env says.
delete process.env.DATABASE_URI;
mongoose.set("bufferCommands", false);
// Service clients are built at import time and need some key; nothing is ever called.
process.env.STRIPE_SECRET_KEY = "sk_test_wiring_only";

/* eslint-disable @typescript-eslint/no-require-imports */
const modules = {
	auth: require("../routes/user-routes/auth.route").default,
	user: require("../routes/user-routes/user.route").default,
	provider: require("../routes/user-routes/provider.route").default,
	admin: require("../routes/admin.route").default,
	email: require("../routes/email.route").default,
	webhook: require("../routes/webhook-routes/webhook.route").default,
	stripe: require("../routes/webhook-routes/stripe.route").default,
	cloudTasks: require("../routes/webhook-routes/cloudtasks.route").default,
};
const { verifyAdminJWT, optionalAdminJWT } = require("../middleware/verifyAdminJWT");
const { requestContext, bindRequestContext } = require("../middleware/requestContext");
const { handleHealthz, handleReadyz } = require("../controllers/health.controller");
const corsOptions = require("../config/corsOptions").default;
/* eslint-enable @typescript-eslint/no-require-imports */

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: any }[] } };

const routesOf = (router: any) =>
	(router.stack as Layer[])
		.filter((layer) => layer.route)
		.map((layer) => ({
			path: layer.route!.path,
			method: Object.keys(layer.route!.methods)[0].toUpperCase(),
			handles: layer.route!.stack.map((s) => s.handle),
		}));

test("every route module loads and is an Express router", () => {
	for (const [name, router] of Object.entries(modules)) {
		assert.equal(typeof router, "function", name);
		assert.ok(Array.isArray(router.stack), `${name} has a stack`);
	}
});

test("the whole app composes like index.ts (without listening or connecting)", () => {
	const app = express();
	app.use(requestContext);
	app.get("/healthz", handleHealthz);
	app.get("/readyz", handleReadyz);
	app.use(cors(corsOptions));
	app.use("/webhook", modules.webhook);
	app.use(express.json());
	app.use(bindRequestContext);
	app.use("/auth", modules.auth);
	app.use("/admin", modules.admin);
	app.use("/email", modules.email);
	assert.ok(app);
});

const PUBLIC_ADMIN_ROUTES = new Set(["POST /login", "POST /login/mfa", "POST /refresh", "POST /logout"]);

test("every admin route that acts for a signed-in admin runs verifyAdminJWT then requirePermission", () => {
	const routes = routesOf(modules.admin);
	assert.ok(routes.length >= 30, `${routes.length} admin routes`);
	for (const route of routes) {
		const id = `${route.method} ${route.path}`;
		if (PUBLIC_ADMIN_ROUTES.has(id)) {
			assert.equal(route.handles.includes(verifyAdminJWT), false, `${id} must work without an access token`);
			continue;
		}
		const verifyAt = route.handles.indexOf(verifyAdminJWT);
		const permissionAt = route.handles.findIndex((handle: any) => typeof handle.permission === "string");
		assert.ok(verifyAt === 0, `${id}: verifyAdminJWT first`);
		assert.ok(permissionAt === 1, `${id}: requirePermission right after`);
	}
	const logout = routes.find((r) => r.method === "POST" && r.path === "/logout");
	assert.ok(logout?.handles.includes(optionalAdminJWT));
});

test("the demo admin's limiter, read-only guard and response masking are mounted on the whole admin router", () => {
	/* eslint-disable-next-line @typescript-eslint/no-require-imports */
	const demo = require("../middleware/demoAdmin");
	/* eslint-disable-next-line @typescript-eslint/no-require-imports */
	const { markRouteBase } = require("../middleware/requestContext");
	const routerLevel = (modules.admin.stack as any[]).filter((layer) => !layer.route).map((layer) => layer.handle);
	assert.equal(routerLevel[0], markRouteBase, "the router records its mount path first (logging)");
	assert.deepEqual(routerLevel.slice(1, 4), [demo.demoAdminRequestLimiter, demo.demoReadOnly, demo.demoResponseMask]);
	const firstRoute = (modules.admin.stack as any[]).findIndex((layer) => layer.route);
	assert.ok(firstRoute >= 4, "mounted before every route");
});

test("the routes and permissions the current console uses are unchanged in path and method", () => {
	const routes = routesOf(modules.admin);
	const permissionOf = (method: string, path: string) =>
		routes.find((r) => r.method === method && r.path === path)?.handles.find((h: any) => h.permission)?.permission;
	assert.ok(routes.some((r) => r.method === "POST" && r.path === "/login"));
	assert.equal(permissionOf("GET", "/account"), "account.self");
	assert.equal(permissionOf("GET", "/provider-account-requests"), "applications.read");
	assert.equal(permissionOf("GET", "/provider-account-requests-complete"), "applications.read");
	assert.equal(permissionOf("POST", "/update-provider-account-request-status"), "applications.review");
	assert.equal(permissionOf("POST", "/signup"), "admins.manage");
	assert.equal(permissionOf("GET", "/audit"), "audit.read");
	assert.equal(permissionOf("POST", "/admins"), "admins.manage");
});

test("user and provider routes keep their paths", () => {
	const auth = routesOf(modules.auth).map((r) => `${r.method} ${r.path}`);
	for (const route of [
		"POST /signup",
		"POST /provider-signup",
		"POST /login",
		"POST /logout",
		"POST /refresh",
		"GET /user-info",
		"POST /complete-booking",
		"POST /cancel-booking",
		"POST /profile",
	]) {
		assert.ok(auth.includes(route), route);
	}
	const provider = routesOf(modules.provider).map((r) => `${r.method} ${r.path}`);
	for (const route of [
		"POST /accept-booking",
		"POST /start-booking",
		"PUT /update-provider-availability",
		"POST /create-payout",
	]) {
		assert.ok(provider.includes(route), route);
	}
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { auditActionsOf } = require("../middleware/audited");
const { AUDIT_ACTIONS } = require("../lib/audit");
const { adminSearchLimiter } = require("../middleware/rateLimit");
/* eslint-enable @typescript-eslint/no-require-imports */

const OPERATIONS_ROUTES: [string, string, string][] = [
	["GET", "/overview", "operations.read"],
	["GET", "/live", "operations.read"],
	["GET", "/search", "operations.read"],
	["GET", "/users", "users.read"],
	["GET", "/users/:id", "users.read"],
	["GET", "/users/:id/balance", "payments.read"],
	["POST", "/users/:id/suspend", "users.manage"],
	["POST", "/users/:id/reinstate", "users.manage"],
	["POST", "/users/:id/end-sessions", "users.manage"],
	["POST", "/users/:id/verify-email", "users.manage"],
	["POST", "/users/:id/resend-verification", "users.manage"],
	["POST", "/users/:id/availability-off", "users.manage"],
	["GET", "/bookings", "bookings.read"],
	["GET", "/bookings/:id", "bookings.read"],
	["POST", "/bookings/:id/cancel", "bookings.manage"],
	["POST", "/bookings/:id/release", "bookings.manage"],
	["POST", "/bookings/:id/resolve", "bookings.manage"],
	["GET", "/payments", "payments.read"],
	["GET", "/payments/:id", "payments.read"],
	["POST", "/payments/:id/refund", "payments.refund"],
	["GET", "/earnings", "payments.read"],
	["GET", "/earnings/:id", "payments.read"],
	["GET", "/payouts", "payments.read"],
	["GET", "/payouts/:id", "payments.read"],
	["POST", "/notes", "notes.manage"],
	["PATCH", "/notes/:id", "notes.manage"],
	["DELETE", "/notes/:id", "notes.manage"],
];

test("every operations route exists with its permission, after the demo guard and masking", () => {
	const routes = routesOf(modules.admin);
	const stack = modules.admin.stack as any[];
	for (const [method, path, permission] of OPERATIONS_ROUTES) {
		const route = routes.find((r) => r.method === method && r.path === path);
		assert.ok(route, `${method} ${path} exists`);
		assert.equal(route!.handles.find((h: any) => h.permission)?.permission, permission, `${method} ${path}`);
		const index = stack.findIndex(
			(layer) => layer.route?.path === path && layer.route.methods[method.toLowerCase()],
		);
		assert.ok(index >= 3, `${method} ${path} is registered after the demo middleware`);
	}
	const searchRoute = routes.find((r) => r.method === "GET" && r.path === "/search");
	assert.ok(searchRoute!.handles.includes(adminSearchLimiter), "global search is rate limited");
	assert.ok(
		searchRoute!.handles.indexOf(adminSearchLimiter) > searchRoute!.handles.findIndex((h: any) => h.permission),
		"limited per admin, after authentication",
	);
});

test("every admin write route is audited: marked with known actions that the controllers record", () => {
	const root = path.resolve(__dirname, "..", "controllers");
	const sources: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts")) sources.push(fs.readFileSync(full, "utf8"));
		}
	};
	walk(root);
	const code = sources.join("\n");
	const writes = routesOf(modules.admin).filter(
		(r) => r.method !== "GET" && !PUBLIC_ADMIN_ROUTES.has(`${r.method} ${r.path}`),
	);
	assert.ok(writes.length >= 28, `${writes.length} write routes`);
	for (const route of writes) {
		const id = `${route.method} ${route.path}`;
		const actions = route.handles.map(auditActionsOf).find(Boolean) as string[] | undefined;
		assert.ok(actions?.length, `${id} is marked with its audit actions`);
		assert.equal(
			route.handles.indexOf(route.handles.find((h: any) => auditActionsOf(h))),
			route.handles.length - 1,
		);
		for (const action of actions!) {
			assert.ok(action in AUDIT_ACTIONS, `${id}: ${action} is a known audit action`);
			assert.ok(code.includes(`"${action}"`), `${id}: ${action} is recorded in a controller`);
		}
	}
	// Admin writes also emit a business event: the operations controllers each call emitEvent.
	for (const file of [
		"users.controller.ts",
		"bookings.controller.ts",
		"payments.controller.ts",
		"operations.controller.ts",
	]) {
		const text = fs.readFileSync(path.join(root, "admin", file), "utf8");
		assert.ok(
			/emitEvent\(|cancelBookingTransition\(|completeBookingTransition\(/.test(text),
			`${file} emits events`,
		);
	}
});
