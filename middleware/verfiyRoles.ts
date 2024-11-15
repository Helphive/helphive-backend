import { Request, Response, NextFunction } from "express";

declare module "express" {
	interface Request {
		user?: string;
		roles?: { User: boolean; Provider: boolean };
	}
}

export type RoleKey = keyof NonNullable<Request["roles"]>;

export const verifyRoles = (...allowedRoles: RoleKey[]) => {
	return (req: Request, res: Response, next: NextFunction) => {
		if (!req.roles) {
			return res.sendStatus(401);
		}
		const hasRole = allowedRoles.some((role) => req.roles && req.roles[role]);
		if (!hasRole) {
			return res.sendStatus(403);
		}
		next();
	};
};
