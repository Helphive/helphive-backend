// The operations console routes, registered on the admin router (routes/admin.route.ts) after its demo-admin limiter,
// read-only guard and response masking. Every route runs verifyAdminJWT then requirePermission; every write route
// is marked with the audit actions it records (tests/adminRoutes.test.ts checks both).
import type { Router } from "express";
import { verifyAdminJWT } from "../middleware/verifyAdminJWT";
import { requirePermission } from "../middleware/requirePermission";
import { audited } from "../middleware/audited";
import { adminSearchLimiter } from "../middleware/rateLimit";
import type { Permission } from "../config/adminPermissions";
import {
	handleEndUserSessions,
	handleGetUser,
	handleListUsers,
	handleMarkEmailVerified,
	handleReinstateUser,
	handleResendVerification,
	handleSetAvailabilityOff,
	handleSuspendUser,
} from "../controllers/admin/users.controller";
import {
	handleCancelBookingForParty,
	handleGetBooking,
	handleListBookings,
	handleReleaseBooking,
	handleResolveBooking,
} from "../controllers/admin/bookings.controller";
import {
	handleGetEarning,
	handleGetPayment,
	handleGetPayout,
	handleGetProviderBalance,
	handleListEarnings,
	handleListPayments,
	handleListPayouts,
	handleRefundPayment,
} from "../controllers/admin/payments.controller";
import {
	handleCreateNote,
	handleDeleteNote,
	handleGlobalSearch,
	handleLive,
	handleOverview,
	handleUpdateNote,
} from "../controllers/admin/operations.controller";
import {
	idParam,
	validateCancelBooking,
	validateCreateNote,
	validateOptionalReason,
	validateReason,
	validateRefund,
	validateResolveBooking,
	validateUpdateNote,
} from "../controllers/admin/operations.validators";

const signedIn = (permission: Permission) => [verifyAdminJWT, requirePermission(permission)];

export const registerOperationsRoutes = (router: Router) => {
	// Overview, live view, global search.
	router.get("/overview", ...signedIn("operations.read"), handleOverview);
	router.get("/live", ...signedIn("operations.read"), handleLive);
	router.get("/search", ...signedIn("operations.read"), adminSearchLimiter, handleGlobalSearch);

	// Users (customers and providers).
	router.get("/users", ...signedIn("users.read"), handleListUsers);
	router.get("/users/:id", ...signedIn("users.read"), idParam("user"), handleGetUser);
	router.get("/users/:id/balance", ...signedIn("payments.read"), idParam("user"), handleGetProviderBalance);
	const userAction = (
		path: string,
		action: Parameters<typeof audited>[0][number],
		handler: any,
		body = validateReason,
	) => router.post(path, ...signedIn("users.manage"), idParam("user"), ...body, audited([action], handler));
	userAction("/users/:id/suspend", "users.suspended", handleSuspendUser);
	userAction("/users/:id/reinstate", "users.reinstated", handleReinstateUser);
	userAction("/users/:id/end-sessions", "users.sessions_ended", handleEndUserSessions);
	userAction("/users/:id/verify-email", "users.email_verified", handleMarkEmailVerified);
	userAction(
		"/users/:id/resend-verification",
		"users.verification_email_sent",
		handleResendVerification,
		validateOptionalReason,
	);
	userAction("/users/:id/availability-off", "users.availability_off", handleSetAvailabilityOff);

	// Bookings.
	router.get("/bookings", ...signedIn("bookings.read"), handleListBookings);
	router.get("/bookings/:id", ...signedIn("bookings.read"), idParam("booking"), handleGetBooking);
	router.post(
		"/bookings/:id/cancel",
		...signedIn("bookings.manage"),
		idParam("booking"),
		...validateCancelBooking,
		audited(["bookings.cancelled"], handleCancelBookingForParty),
	);
	router.post(
		"/bookings/:id/release",
		...signedIn("bookings.manage"),
		idParam("booking"),
		...validateReason,
		audited(["bookings.released"], handleReleaseBooking),
	);
	router.post(
		"/bookings/:id/resolve",
		...signedIn("bookings.manage"),
		idParam("booking"),
		...validateResolveBooking,
		audited(["bookings.resolved_completed", "bookings.resolved_cancelled"], handleResolveBooking),
	);

	// Payments and refunds.
	router.get("/payments", ...signedIn("payments.read"), handleListPayments);
	router.get("/payments/:id", ...signedIn("payments.read"), idParam("payment"), handleGetPayment);
	router.post(
		"/payments/:id/refund",
		...signedIn("payments.refund"),
		idParam("payment"),
		...validateRefund,
		audited(["payments.refunded"], handleRefundPayment),
	);

	// Earnings and payouts (read only in this phase).
	router.get("/earnings", ...signedIn("payments.read"), handleListEarnings);
	router.get("/earnings/:id", ...signedIn("payments.read"), idParam("earning"), handleGetEarning);
	router.get("/payouts", ...signedIn("payments.read"), handleListPayouts);
	router.get("/payouts/:id", ...signedIn("payments.read"), idParam("payout"), handleGetPayout);

	// Admin notes (read on each record's detail page).
	router.post(
		"/notes",
		...signedIn("notes.manage"),
		...validateCreateNote,
		audited(["notes.created"], handleCreateNote),
	);
	router.patch(
		"/notes/:id",
		...signedIn("notes.manage"),
		idParam("note"),
		...validateUpdateNote,
		audited(["notes.updated"], handleUpdateNote),
	);
	router.delete(
		"/notes/:id",
		...signedIn("notes.manage"),
		idParam("note"),
		...validateReason,
		audited(["notes.deleted"], handleDeleteNote),
	);
};
