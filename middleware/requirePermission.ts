import { NextFunction, Request, Response } from "express";
import { hasPermission, type Permission } from "../config/adminPermissions";

export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";

/**
 * After verifyAdminJWT: the signed-in admin's role must grant `permission`. An admin still on a one-time password may
 * use only their own account routes ("account.self") until they change it.
 */
export const requirePermission = (permission: Permission) => {
	const middleware = (req: Request, res: Response, next: NextFunction) => {
		const admin = req.admin;
		if (!admin) return res.status(401).json({ message: "Not authorized" });
		if (admin.mustChangePassword && permission !== "account.self") {
			return res
				.status(403)
				.json({ message: "Change your one-time password to continue.", code: PASSWORD_CHANGE_REQUIRED });
		}
		if (!hasPermission(admin, permission)) {
			return res.status(403).json({ message: "Your role does not allow this.", permission });
		}
		next();
	};
	// Lets tests read which permission guards a route.
	(middleware as typeof middleware & { permission: Permission }).permission = permission;
	return middleware;
};
