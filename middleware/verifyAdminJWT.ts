import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import AdminModel, { Admin } from "../dal/models/admin.model";
import { JWT_ALGORITHMS } from "../controllers/user-controllers/utils/token.utils";

declare module "express" {
	interface Request {
		admin?: Admin;
	}
}

export const ADMIN_TOKEN_AUDIENCE = "helphive-admin";
// Short enough that a leaked token is soon useless; the admin app signs in again when its token expires.
export const ADMIN_TOKEN_TTL = "8h";

/** Admin tokens get their own secret. Until ADMIN_ACCESS_TOKEN_SECRET is set the user secret is used, and the
 * audience claim alone keeps the two kinds of token apart. */
export const adminTokenSecret = () => process.env.ADMIN_ACCESS_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET || "";

export const isActiveAdmin = (admin: Pick<Admin, "roles"> | null | undefined) =>
	!!admin && (!!admin.roles?.admin || !!admin.roles?.superAdmin);

export const signAdminToken = (admin: Admin) =>
	jwt.sign(
		{
			UserInfo: { email: admin.email, roles: Object.values(admin.roles).filter(Boolean) },
			tv: admin.tokenVersion ?? 0,
		},
		adminTokenSecret(),
		{ expiresIn: ADMIN_TOKEN_TTL, audience: ADMIN_TOKEN_AUDIENCE, algorithm: "HS256" },
	);

const unauthorized = (res: Response) => res.status(401).json({ message: "Not authorized" });

export const verifyAdminJWT = async (req: Request, res: Response, next: NextFunction) => {
	const authHeader = req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return res.status(401).json({ message: "No token, authorization denied" });
	}

	const secret = adminTokenSecret();
	if (!secret) return res.status(500).json({ message: "Server error" });

	let decoded: any;
	try {
		decoded = jwt.verify(authHeader.slice(7), secret, {
			algorithms: JWT_ALGORITHMS,
			audience: ADMIN_TOKEN_AUDIENCE,
		});
	} catch {
		return unauthorized(res);
	}
	const email = decoded?.UserInfo?.email;
	if (typeof email !== "string" || !email || typeof decoded?.tv !== "number") return unauthorized(res);

	try {
		const admin = await AdminModel.findOne({ email }).exec();
		// A raised tokenVersion (sign-out everywhere, or a revoked admin) invalidates every earlier token.
		if (!admin || !isActiveAdmin(admin) || (admin.tokenVersion ?? 0) !== decoded.tv) return unauthorized(res);
		req.admin = admin;
		next();
	} catch (error) {
		console.error("Error verifying admin token:", error);
		return res.status(500).json({ message: "Server error" });
	}
};

/** After verifyAdminJWT: only a super admin may continue. */
export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction) => {
	if (!req.admin?.roles?.superAdmin) return res.status(403).json({ message: "Only a super admin can do this." });
	next();
};
