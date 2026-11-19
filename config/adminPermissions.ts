// Admin roles and what each may do: the one place this is defined. Routes ask for a permission
// (middleware/requirePermission.ts); the console asks GET /admin/account for the signed-in admin's list.
//
import { isDemoAdminEmail } from "./demoAccounts";

// Adding a permission: add it to PERMISSIONS with a description, grant it to roles below, protect the route with
// requirePermission("<name>"), and list it in backend-platform.md. superAdmin always gets every permission.

export const PERMISSIONS = {
	"account.self": "Own account: profile, password, sessions and two-step sign-in. Every role has it.",
	"applications.read": "List and open provider applications, including their documents.",
	"applications.review": "Approve or reject provider applications.",
	"users.read": "List and open customer and provider accounts.",
	"users.manage": "Change, suspend or restore customer and provider accounts.",
	"bookings.read": "List and open bookings.",
	"bookings.manage": "Change, cancel or reassign bookings.",
	"payments.read": "See payments, refunds, earnings and payouts.",
	"payments.refund": "Issue refunds.",
	"payouts.manage": "Retry, hold or release earnings and payouts.",
	"analytics.read": "Dashboards and the business event stream.",
	"observability.read":
		"Request metrics, errors, logs, webhook deliveries, task runs, dependencies, releases and alerts.",
	"observability.manage":
		"Resolve or ignore errors, replay failed webhooks and tasks, manage alert rules and alerts.",
	"risk.read": "Fraud and risk signals.",
	"risk.manage": "Act on risk signals (block devices, flag accounts).",
	"support.read": "Read support cases and customer history.",
	"support.manage": "Work support cases and contact customers.",
	"settings.manage": "Platform settings.",
	"admins.manage": "Create admins, change roles, disable, sign out and reset two-step sign-in.",
	"audit.read": "The admin audit log.",
	"operations.read": "The operations overview, the live view and the global search.",
	"notes.manage": "Add, edit and delete admin notes on users, bookings, payments and applications.",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ADMIN_ROLES = ["superAdmin", "operations", "finance", "support", "analyst", "demo"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ROLE_LABELS: Record<AdminRole, string> = {
	superAdmin: "Super admin",
	operations: "Operations",
	finance: "Finance",
	support: "Support",
	analyst: "Analyst",
	demo: "Demo (read only, masked)",
};

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
	superAdmin: ALL_PERMISSIONS,
	operations: [
		"account.self",
		"applications.read",
		"applications.review",
		"users.read",
		"users.manage",
		"bookings.read",
		"bookings.manage",
		"payments.read",
		"analytics.read",
		"observability.read",
		"observability.manage",
		"risk.read",
		"risk.manage",
		"support.read",
		"support.manage",
		"audit.read",
		"operations.read",
		"notes.manage",
	],
	finance: [
		"account.self",
		"users.read",
		"bookings.read",
		"payments.read",
		"payments.refund",
		"payouts.manage",
		"analytics.read",
		"audit.read",
		"operations.read",
		"notes.manage",
	],
	support: [
		"account.self",
		"applications.read",
		"users.read",
		"bookings.read",
		"payments.read",
		"support.read",
		"support.manage",
		"operations.read",
		"notes.manage",
	],
	// Read-only: every permission except account.self ends in ".read".
	analyst: [
		"account.self",
		"applications.read",
		"users.read",
		"bookings.read",
		"payments.read",
		"analytics.read",
		"observability.read",
		"risk.read",
		"support.read",
		"audit.read",
		"operations.read",
	],
	// The public demo login: what an analyst can read, nothing else. Every response to it is masked and every write
	// refused (middleware/demoAdmin.ts); the permissions alone are not what keeps it safe.
	demo: [
		"account.self",
		"applications.read",
		"users.read",
		"bookings.read",
		"payments.read",
		"analytics.read",
		"observability.read",
		"risk.read",
		"support.read",
		"audit.read",
		"operations.read",
	],
};

export const isAdminRole = (value: unknown): value is AdminRole =>
	typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);

export interface RoleSource {
	role?: unknown;
	roles?: { admin?: boolean; superAdmin?: boolean } | null;
	email?: unknown;
}

/**
 * The effective role. New and edited admins carry `role`; documents from before roles existed carry only the
 * `roles: { admin, superAdmin }` flags and read as superAdmin when that flag is set, operations otherwise (what every
 * admin could do before: review applications). No migration is needed.
 */
export const effectiveRole = (admin: RoleSource): AdminRole => {
	// The demo login's email decides first, so a mistaken role on that account can never grant more.
	if (isDemoAdminEmail(admin.email)) return "demo";
	if (isAdminRole(admin.role)) return admin.role;
	return admin.roles?.superAdmin ? "superAdmin" : "operations";
};

export const permissionsFor = (role: AdminRole): Permission[] => [...ROLE_PERMISSIONS[role]];

export const hasPermission = (admin: RoleSource, permission: Permission) =>
	ROLE_PERMISSIONS[effectiveRole(admin)].includes(permission);

export const isDemoAdmin = (admin: RoleSource | null | undefined) => !!admin && effectiveRole(admin) === "demo";

/** The legacy flags kept in step with `role`, so older code and the current console read the same thing. */
export const legacyFlagsFor = (role: AdminRole) => ({ admin: true, superAdmin: role === "superAdmin" });
