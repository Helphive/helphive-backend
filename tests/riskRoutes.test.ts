// The risk routes: each guarded by verifyAdminJWT then requirePermission (risk.read reads, risk.manage writes), then
// a per-admin rate limit, registered after the demo guard and masking. No server, no database.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

delete process.env.DATABASE_URI;
mongoose.set("bufferCommands", false);
process.env.STRIPE_SECRET_KEY = "sk_test_wiring_only";

/* eslint-disable @typescript-eslint/no-require-imports */
const admin = require("../routes/admin.route").default;
const { verifyAdminJWT } = require("../middleware/verifyAdminJWT");
const { riskReadLimiter, riskWriteLimiter, riskHeavyLimiter } = require("../routes/adminRisk.route");
/* eslint-enable @typescript-eslint/no-require-imports */

const routes = (admin.stack as any[])
	.map((layer, index) => ({ layer, index }))
	.filter(({ layer }) => layer.route?.path?.startsWith("/risk"))
	.map(({ layer, index }) => ({
		id: `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`,
		index,
		handles: layer.route.stack.map((s: any) => s.handle),
	}));

test("every risk route: admin token, then the risk permission, then a rate limit, after the demo middleware", () => {
	assert.ok(routes.length >= 25, `${routes.length} risk routes`);
	for (const route of routes) {
		assert.equal(route.handles[0], verifyAdminJWT, route.id);
		const permission = route.handles[1].permission;
		const isRead = route.id.startsWith("GET ");
		assert.equal(permission, isRead ? "risk.read" : "risk.manage", route.id);
		assert.ok(
			[riskReadLimiter, riskWriteLimiter, riskHeavyLimiter].includes(route.handles[2]),
			`${route.id} rate limited`,
		);
		assert.ok(route.index >= 3, `${route.id} after the demo guard and masking`);
	}
});

test("backtests and graphs use the tighter limiter, and are reads (GET) so the demo admin can run them", () => {
	for (const id of ["GET /risk/backtest", "GET /risk/users/:id/graph"]) {
		const route = routes.find((r) => r.id === id);
		assert.ok(route, id);
		assert.equal(route!.handles[2], riskHeavyLimiter);
	}
});
