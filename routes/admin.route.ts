import express from "express";
import {
	handleSignup,
	handleGetProviderAccountRequests,
	handleUpdateProviderAccountRequestStatus,
	handleGetProviderAccountRequestsComplete,
} from "../controllers/admin.controller";
import {
	handleChangePassword,
	handleGetAccount,
	handleGetRoles,
	handleListSessions,
	handleLogin,
	handleLoginMfa,
	handleLogout,
	handleLogoutAll,
	handleRefresh,
	handleRevokeSession,
} from "../controllers/admin/auth.controller";
import {
	handleConfirmMfa,
	handleDisableMfa,
	handleEnrollMfa,
	handleGetMfa,
	handleRegenerateRecoveryCodes,
} from "../controllers/admin/mfa.controller";
import {
	handleChangeAdminRole,
	handleCreateAdmin,
	handleDisableAdmin,
	handleEnableAdmin,
	handleForceSignOut,
	handleGetAdmin,
	handleListAdmins,
	handleResetAdminMfa,
} from "../controllers/admin/admins.controller";
import { handleGetAuditEntry, handleListAudit, handleListAuditActions } from "../controllers/admin/audit.controller";
import { validateSignupFields, validateLoginFields } from "../controllers/user-controllers/validators/auth.validators";
import {
	adminIdParam,
	auditIdParam,
	sessionIdParam,
	validateChangePassword,
	validateCreateAdmin,
	validateLoginMfa,
	validateOptionalReason,
	validateRequiredReason,
	validateRoleChange,
	validateSecondFactor,
	validateTotpCode,
	validateUpdateProviderAccountRequestStatus,
} from "../controllers/user-controllers/validators/admin.validators";
import { optionalAdminJWT, verifyAdminJWT } from "../middleware/verifyAdminJWT";
import { audited } from "../middleware/audited";
import { registerOperationsRoutes } from "./adminOperations.route";
import { registerFinanceRoutes } from "./adminFinance.route";
import { requirePermission } from "../middleware/requirePermission";
import {
	demoAdminRequestLimiter,
	demoAdminSignInLimiter,
	demoReadOnly,
	demoResponseMask,
} from "../middleware/demoAdmin";
import {
	adminLoginLimiters,
	adminMfaLimiters,
	adminPasswordChangeLimiter,
	adminRefreshLimiters,
} from "../middleware/rateLimit";

const adminRoute = express.Router();

// The public demo admin, for every route here and any added later: per-address limits, no writes except its own
// sign-in, refresh and sign-out (403 demo_read_only), and every successful response masked (lib/demoMask.ts).
adminRoute.use(demoAdminRequestLimiter, demoReadOnly, demoResponseMask);

// Preflight is answered by the app-wide CORS middleware, which for /admin allows only the admin console's origins.
//
// Every route that acts for a signed-in admin runs verifyAdminJWT then requirePermission(<permission>). The four
// routes before sign-in (login, login/mfa, refresh, logout) authenticate with a password, a challenge or the refresh
// cookie instead. tests/adminRoutes.test.ts checks this for every route.
const signedIn = (permission: Parameters<typeof requirePermission>[0]) => [
	verifyAdminJWT,
	requirePermission(permission),
];

// Sign-in and session.
adminRoute.post("/login", demoAdminSignInLimiter, ...adminLoginLimiters, validateLoginFields, handleLogin);
adminRoute.post("/login/mfa", ...adminMfaLimiters, validateLoginMfa, handleLoginMfa);
adminRoute.post("/refresh", ...adminRefreshLimiters, handleRefresh);
adminRoute.post("/logout", optionalAdminJWT, handleLogout);
adminRoute.post("/logout-all", ...signedIn("account.self"), audited(["auth.logout_all"], handleLogoutAll));
adminRoute.get("/sessions", ...signedIn("account.self"), handleListSessions);
adminRoute.delete(
	"/sessions/:id",
	...signedIn("account.self"),
	sessionIdParam,
	audited(["auth.session.revoked"], handleRevokeSession),
);

// Own account.
adminRoute.get("/account", ...signedIn("account.self"), handleGetAccount);
adminRoute.get("/roles", ...signedIn("account.self"), handleGetRoles);
adminRoute.post(
	"/change-password",
	...signedIn("account.self"),
	adminPasswordChangeLimiter,
	validateChangePassword,
	audited(["account.password.changed"], handleChangePassword),
);
adminRoute.get("/mfa", ...signedIn("account.self"), handleGetMfa);
adminRoute.post(
	"/mfa/enroll",
	...signedIn("account.self"),
	audited(["account.mfa.enrollment_started"], handleEnrollMfa),
);
adminRoute.post(
	"/mfa/confirm",
	...signedIn("account.self"),
	...adminMfaLimiters,
	validateTotpCode,
	audited(["account.mfa.enabled"], handleConfirmMfa),
);
adminRoute.post(
	"/mfa/disable",
	...signedIn("account.self"),
	...adminMfaLimiters,
	validateSecondFactor,
	audited(["account.mfa.disabled"], handleDisableMfa),
);
adminRoute.post(
	"/mfa/recovery-codes",
	...signedIn("account.self"),
	...adminMfaLimiters,
	validateTotpCode,
	audited(["account.mfa.recovery_codes_regenerated"], handleRegenerateRecoveryCodes),
);

// Admin management.
adminRoute.get("/admins", ...signedIn("admins.manage"), handleListAdmins);
adminRoute.post(
	"/admins",
	...signedIn("admins.manage"),
	validateCreateAdmin,
	audited(["admins.created"], handleCreateAdmin),
);
adminRoute.get("/admins/:id", ...signedIn("admins.manage"), adminIdParam, handleGetAdmin);
adminRoute.patch(
	"/admins/:id/role",
	...signedIn("admins.manage"),
	adminIdParam,
	validateRoleChange,
	audited(["admins.role_changed"], handleChangeAdminRole),
);
adminRoute.post(
	"/admins/:id/disable",
	...signedIn("admins.manage"),
	adminIdParam,
	validateRequiredReason,
	audited(["admins.disabled"], handleDisableAdmin),
);
adminRoute.post(
	"/admins/:id/enable",
	...signedIn("admins.manage"),
	adminIdParam,
	validateOptionalReason,
	audited(["admins.enabled"], handleEnableAdmin),
);
adminRoute.post(
	"/admins/:id/sign-out",
	...signedIn("admins.manage"),
	adminIdParam,
	validateOptionalReason,
	audited(["admins.signed_out"], handleForceSignOut),
);
adminRoute.post(
	"/admins/:id/reset-mfa",
	...signedIn("admins.manage"),
	adminIdParam,
	validateRequiredReason,
	audited(["admins.mfa_reset"], handleResetAdminMfa),
);
// Older way to create an admin (the current console's form); creates an operations admin with the given password.
adminRoute.post(
	"/signup",
	...signedIn("admins.manage"),
	validateSignupFields,
	audited(["admins.created"], handleSignup),
);

// Audit log (read only; there is no write, update or delete route).
adminRoute.get("/audit", ...signedIn("audit.read"), handleListAudit);
adminRoute.get("/audit/actions", ...signedIn("audit.read"), handleListAuditActions);
adminRoute.get("/audit/:id", ...signedIn("audit.read"), auditIdParam, handleGetAuditEntry);

// Provider applications (paths and shapes unchanged).
adminRoute.get("/provider-account-requests", ...signedIn("applications.read"), handleGetProviderAccountRequests);
adminRoute.get(
	"/provider-account-requests-complete",
	...signedIn("applications.read"),
	handleGetProviderAccountRequestsComplete,
);
adminRoute.post(
	"/update-provider-account-request-status",
	...signedIn("applications.review"),
	validateUpdateProviderAccountRequestStatus,
	audited(["applications.approved", "applications.rejected"], handleUpdateProviderAccountRequestStatus),
);

// Operations console: overview, users, bookings, payments, earnings, payouts, live view, search, notes
// (routes/adminOperations.route.ts). Registered here so the demo guard and masking above cover them.
registerOperationsRoutes(adminRoute);
// Finance, support and platform: reconciliation, disputes, settings, cases, notifications (routes/adminFinance.route.ts).
registerFinanceRoutes(adminRoute);

export default adminRoute;
