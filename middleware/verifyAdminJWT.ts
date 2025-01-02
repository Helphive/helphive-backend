import { NextFunction, Request, Response } from "express";
import AdminModel from "../dal/models/admin.model";
import jwt from "jsonwebtoken";

export const verifyAdminJWT = async (req: Request, res: Response, next: NextFunction) => {
	const authHeader = req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return res.status(401).json({ message: "No token, authorization denied" });
	}

	const token = authHeader.split(" ")[1];

	try {
		const secret = process.env.ACCESS_TOKEN_SECRET;
		if (!secret) {
			return res.status(500).json({ message: "Server error: missing token secret" });
		}
		const decoded = jwt.verify(token, secret);
		if (decoded) {
			const user = await AdminModel.findOne({ email: (decoded as any).UserInfo.email });
			if (user) {
				if (user.roles.admin) {
					req.body.user = user;
					next();
				} else {
					return res.status(401).json({ message: "Not authorized" });
				}
			} else {
				return res.status(404).json({ message: "User not found" });
			}
		}
	} catch (error) {
		console.error(error);
		return res.status(500).json({ message: "Server error" });
	}
};
