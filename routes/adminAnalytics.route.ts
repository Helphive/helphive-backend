// Analytics routes (permission analytics.read), registered on the admin router (routes/admin.route.ts) after its
// demo-admin limiter, read-only guard and response masking. Every route runs verifyAdminJWT, requirePermission, then
// a per-admin limiter; the saved-view writes are marked with the audit actions they record.
import type { Request, Router } from "express";
import { verifyAdminJWT } from "../middleware/verifyAdminJWT";
import { requirePermission } from "../middleware/requirePermission";
import { audited } from "../middleware/audited";
import { createLimiter } from "../middleware/rateLimit";
import { idParam } from "../controllers/admin/operations.validators";
import {
	handleCohorts,
	handleCreateView,
	handleDeleteView,
	handleDistribution,
	handleFunnel,
	handleLeaderboard,
	handleListMetrics,
	handleListViews,
	handleSeries,
	handleSeriesCsv,
	handleSummary,
	handleSupplyDemand,
	handleUpdateView,
} from "../controllers/admin/analytics.controller";

/** Per signed-in admin, per instance: a dashboard load is about 15 requests; room for fast filter changes. */
export const ANALYTICS_RATE_LIMIT = { windowMs: 60 * 1000, limit: 180 };

export const analyticsLimiter = createLimiter({
	name: "admin-analytics",
	rule: ANALYTICS_RATE_LIMIT,
	kind: "local",
	key: (req: Request) => (req.admin ? `admin-analytics:${String(req.admin._id)}` : null),
});

const reader = [verifyAdminJWT, requirePermission("analytics.read"), analyticsLimiter];

export const registerAnalyticsRoutes = (router: Router) => {
	router.get("/analytics/metrics", ...reader, handleListMetrics);
	router.get("/analytics/series", ...reader, handleSeries);
	router.get("/analytics/series.csv", ...reader, handleSeriesCsv);
	router.get("/analytics/summary", ...reader, handleSummary);
	router.get("/analytics/funnel", ...reader, handleFunnel);
	router.get("/analytics/cohorts", ...reader, handleCohorts);
	router.get("/analytics/supply-demand", ...reader, handleSupplyDemand);
	router.get("/analytics/leaderboards", ...reader, handleLeaderboard);
	router.get("/analytics/distribution", ...reader, handleDistribution);

	// Saved views: own and shared ones listed; only the owner changes or deletes.
	router.get("/analytics/views", ...reader, handleListViews);
	router.post("/analytics/views", ...reader, audited(["analytics.view_created"], handleCreateView));
	router.patch(
		"/analytics/views/:id",
		...reader,
		...idParam("view"),
		audited(["analytics.view_updated"], handleUpdateView),
	);
	router.delete(
		"/analytics/views/:id",
		...reader,
		...idParam("view"),
		audited(["analytics.view_deleted"], handleDeleteView),
	);
};
