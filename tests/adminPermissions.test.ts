// Run with: npx ts-node tests/adminPermissions.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	ADMIN_ROLES,
	ALL_PERMISSIONS,
	PERMISSIONS,
	ROLE_PERMISSIONS,
	effectiveRole,
	hasPermission,
	isAdminRole,
	legacyFlagsFor,
	permissionsFor,
} from "../config/adminPermissions";
import { requirePermission, PASSWORD_CHANGE_REQUIRED } from "../middleware/requirePermission";
import { wouldRemoveLastSuperAdmin, generateTemporaryPassword } from "../controllers/admin/admins.controller";
import { isActiveAdmin } from "../middleware/verifyAdminJWT";

test("legacy admins: roles.superAdmin reads as superAdmin, anything else as operations; role field wins", () => {
	assert.equal(effectiveRole({ roles: { admin: true, superAdmin: true } }), "superAdmin");
	assert.equal(effectiveRole({ roles: { admin: true, superAdmin: false } }), "operations");
	assert.equal(effectiveRole({ roles: { admin: false, superAdmin: false } }), "operations");
	assert.equal(effectiveRole({}), "operations");
	assert.equal(effectiveRole({ role: "analyst", roles: { admin: true, superAdmin: false } }), "analyst");
	assert.equal(effectiveRole({ role: "finance", roles: { admin: true, superAdmin: true } }), "finance");
	assert.equal(
		effectiveRole({ role: "owner", roles: { admin: true, superAdmin: true } }),
		"superAdmin",
		"unknown role ignored",
	);
	assert.equal(isAdminRole("support"), true);
	assert.equal(isAdminRole({ $ne: 1 }), false);
});

test("today's console keeps working for legacy admins: both legacy roles can read and review applications", () => {
	for (const roles of [
		{ admin: true, superAdmin: false },
		{ admin: true, superAdmin: true },
	]) {
		assert.ok(hasPermission({ roles }, "applications.read"));
		assert.ok(hasPermission({ roles }, "applications.review"));
		assert.ok(hasPermission({ roles }, "account.self"));
	}
	assert.equal(hasPermission({ roles: { admin: true, superAdmin: false } }, "admins.manage"), false);
	assert.equal(hasPermission({ roles: { admin: true, superAdmin: true } }, "admins.manage"), true);
});

test("permission map: super admin has everything, analyst is read-only, every role can manage its own account", () => {
	assert.deepEqual([...ROLE_PERMISSIONS.superAdmin].sort(), [...ALL_PERMISSIONS].sort());
	for (const permission of ROLE_PERMISSIONS.analyst) {
		assert.ok(permission === "account.self" || permission.endsWith(".read"), `analyst has ${permission}`);
	}
	for (const role of ADMIN_ROLES) {
		assert.ok(ROLE_PERMISSIONS[role].includes("account.self"), role);
		for (const permission of ROLE_PERMISSIONS[role]) assert.ok(permission in PERMISSIONS, `${role}: ${permission}`);
		assert.equal(new Set(ROLE_PERMISSIONS[role]).size, ROLE_PERMISSIONS[role].length, `${role} has duplicates`);
	}
	// Only super admins manage admins or settings; only finance and super admins move money.
	for (const role of ADMIN_ROLES.filter((r) => r !== "superAdmin")) {
		assert.equal(ROLE_PERMISSIONS[role].includes("admins.manage"), false, role);
		assert.equal(ROLE_PERMISSIONS[role].includes("settings.manage"), false, role);
	}
	for (const role of ["operations", "support", "analyst"] as const) {
		assert.equal(ROLE_PERMISSIONS[role].includes("payments.refund"), false, role);
		assert.equal(ROLE_PERMISSIONS[role].includes("payouts.manage"), false, role);
	}
	assert.deepEqual(permissionsFor("support"), [...ROLE_PERMISSIONS.support]);
	assert.deepEqual(legacyFlagsFor("superAdmin"), { admin: true, superAdmin: true });
	assert.deepEqual(legacyFlagsFor("analyst"), { admin: true, superAdmin: false });
});

const run = (middleware: any, admin: any) => {
	const res: any = { statusCode: 200, body: undefined };
	res.status = (code: number) => ((res.statusCode = code), res);
	res.json = (body: unknown) => ((res.body = body), res);
	let passed = false;
	middleware({ admin } as any, res, () => (passed = true));
	return { passed, res };
};

test("requirePermission: 401 without an admin, 403 without the permission, one-time password limits to own account", () => {
	assert.equal(run(requirePermission("audit.read"), undefined).res.statusCode, 401);
	assert.equal(run(requirePermission("audit.read"), { role: "support", roles: { admin: true } }).res.statusCode, 403);
	assert.equal(run(requirePermission("audit.read"), { role: "analyst", roles: { admin: true } }).passed, true);
	const fresh = { role: "operations", roles: { admin: true }, mustChangePassword: true };
	const blocked = run(requirePermission("applications.read"), fresh);
	assert.equal(blocked.res.statusCode, 403);
	assert.equal(blocked.res.body.code, PASSWORD_CHANGE_REQUIRED);
	assert.equal(run(requirePermission("account.self"), fresh).passed, true);
});

test("active admins: disabled ones and ones with neither legacy flag cannot sign in", () => {
	assert.equal(isActiveAdmin({ roles: { admin: true, superAdmin: false } }), true);
	assert.equal(isActiveAdmin({ roles: { admin: true, superAdmin: false }, disabled: true }), false);
	assert.equal(isActiveAdmin({ roles: { admin: false, superAdmin: false } }), false);
	assert.equal(isActiveAdmin(null), false);
});

test("the last active super admin cannot be disabled or demoted", () => {
	const superAdmin = { role: "superAdmin" as const, roles: { admin: true, superAdmin: true } };
	const legacySuper = { roles: { admin: true, superAdmin: true } };
	assert.equal(wouldRemoveLastSuperAdmin(superAdmin, { disable: true }, 0), true);
	assert.equal(wouldRemoveLastSuperAdmin(superAdmin, { role: "operations" }, 0), true);
	assert.equal(wouldRemoveLastSuperAdmin(legacySuper, { role: "analyst" }, 0), true, "legacy super admin counts");
	assert.equal(wouldRemoveLastSuperAdmin(superAdmin, { role: "superAdmin" }, 0), false);
	assert.equal(wouldRemoveLastSuperAdmin(superAdmin, { disable: true }, 1), false, "another one remains");
	assert.equal(
		wouldRemoveLastSuperAdmin({ role: "finance", roles: { admin: true, superAdmin: false } }, { disable: true }, 0),
		false,
	);
	assert.equal(wouldRemoveLastSuperAdmin({ ...superAdmin, disabled: true }, { role: "analyst" }, 0), false);
});

test("one-time passwords meet the user password policy", () => {
	for (let i = 0; i < 200; i++) {
		const password = generateTemporaryPassword();
		assert.equal(password.length, 20);
		assert.match(password, /[a-z]/);
		assert.match(password, /[A-Z]/);
		assert.match(password, /[0-9]/);
		assert.match(password, /[^A-Za-z0-9]/);
	}
});
