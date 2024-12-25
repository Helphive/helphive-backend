import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt, { VerifyErrors } from "jsonwebtoken";
import { validationResult } from "express-validator";
import { GetSignedUrlConfig } from "@google-cloud/storage";
import { googleStorage, providerAccountBucket, userProfilesBucket } from "./service-accounts/cloud-storage";

import Admin from "../dal/models/admin.model";
import ProviderApplicationModel from "../dal/models/providerapplication.model";
import UserModel from "../dal/models/user.model";
import path from "path";

const accessTokenKey = process.env.ACCESS_TOKEN_SECRET || "";
const refreshTokenKey = process.env.REFRESH_TOKEN_SECRET || "";

export const handleSignup = async (req: Request, res: Response) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Email and password are required.",
				errors: errors.array(),
			});
		}

		const { email, password } = req.body;

		const existingAdmin = await Admin.findOne({ email });
		if (existingAdmin) {
			return res.status(409).json({ message: "Admin already exists" });
		}

		const hashedPassword = await bcrypt.hash(password, 10);

		const newAdmin = new Admin({
			email,
			password: hashedPassword,
			roles: {
				admin: true,
			},
		});
		await newAdmin.save();

		res.status(201).json({ message: "Admin created successfully" });
	} catch (error) {
		console.error("Error signing up:", error);
		res.status(500).json({ message: error });
	}
};

export const handleLogin = async (req: Request, res: Response) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Username and password are required.",
				errors: errors.array(),
			});
		}
		const { email, password } = req.body;
		const cookies = req.cookies;

		const admin = await Admin.findOne({ email });
		if (!admin) return res.status(401).json({ message: "Invalid credentials" });
		const passwordMatch = await bcrypt.compare(password, admin.password);
		if (passwordMatch) {
			const roles = Object.values(admin.roles).filter(Boolean);
			const accessToken = jwt.sign(
				{
					UserInfo: {
						email: admin.email,
						roles: roles,
					},
				},
				accessTokenKey,
				{ expiresIn: "600s" },
			);
			const newRefreshToken = jwt.sign({ username: admin.email }, refreshTokenKey, { expiresIn: "1d" });

			let newRefreshTokenArray = admin.refreshToken.filter((rt) => rt !== cookies.jwt);

			if (cookies.jwt) {
				const refreshToken = cookies.jwt;
				const foundToken = await Admin.findOne({ refreshToken });
				if (!foundToken || jwt.verify(refreshToken, refreshTokenKey)) {
					newRefreshTokenArray = [];
					res.clearCookie("jwt", {
						httpOnly: true,
						sameSite: "none",
						secure: true,
					});
				}
			}

			admin.refreshToken = [...newRefreshTokenArray, newRefreshToken];
			await admin.save();

			res.cookie("jwt", newRefreshToken, {
				httpOnly: true,
				secure: true,
				sameSite: "none",
				maxAge: 24 * 60 * 60 * 1000,
			});
			res.json({ user: admin, secretToken: accessToken });
		} else {
			res.sendStatus(401);
		}
	} catch (error) {
		console.error("Error logging in:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

export const handleLogout = async (req: Request, res: Response) => {
	// On client, also delete the accessToken
	const cookies = req.cookies;
	if (!cookies?.jwt) return res.sendStatus(204);
	const refreshToken = cookies.jwt;

	const foundAdmin = await Admin.findOne({ refreshToken }).exec();
	if (!foundAdmin) {
		res.clearCookie("jwt", {
			httpOnly: true,
			sameSite: "none",
			secure: true,
		});
		return res.sendStatus(204);
	}

	foundAdmin.refreshToken = foundAdmin.refreshToken.filter((rt) => rt !== refreshToken);
	const result = await foundAdmin.save();
	console.log(result);

	res.clearCookie("jwt", { httpOnly: true, sameSite: "none", secure: true });
	res.sendStatus(204);
};

export const handleRefreshToken = async (req: Request, res: Response) => {
	const cookies = req.cookies;
	if (!cookies?.jwt) return res.send(401).json({ message: "Unauthorized access!" });
	const refreshToken = cookies.jwt;
	res.clearCookie("jwt", { httpOnly: true, sameSite: "none", secure: true });

	const foundAdmin = await Admin.findOne({ refreshToken });

	if (!foundAdmin) {
		jwt.verify(refreshToken, refreshTokenKey, async (error: VerifyErrors | null, decoded: any) => {
			if (error) return res.send(403).json({ message: "Access forbidden!" });
			const hackedUser = await Admin.findOne({
				email: decoded?.email,
			});
			if (hackedUser) {
				hackedUser.refreshToken = [];
				await hackedUser.save();
			}
		});
		return res.send(403).json({ message: "Access forbidden!" });
	}

	const newRefreshTokenArray = foundAdmin.refreshToken.filter((rt) => rt !== refreshToken);

	jwt.verify(refreshToken, refreshTokenKey, async (error: VerifyErrors | null, decoded: any) => {
		if (error) {
			foundAdmin.refreshToken = [...newRefreshTokenArray];
			await foundAdmin.save();
		}
		if (error || foundAdmin.email !== decoded.email) return res.send(403).json({ message: "Access forbidden!" });

		const roles = Object.values(foundAdmin.roles);
		const accessToken = jwt.sign(
			{
				UserInfo: {
					emmail: decoded.email,
					roles: roles,
				},
			},
			accessTokenKey,
			{ expiresIn: "600s" },
		);

		const newRefreshToken = jwt.sign({ email: foundAdmin.email }, refreshTokenKey, { expiresIn: "1d" });

		foundAdmin.refreshToken = [...newRefreshTokenArray, newRefreshToken];
		await foundAdmin.save();

		res.cookie("jwt", newRefreshToken, {
			httpOnly: true,
			secure: true,
			sameSite: "none",
			maxAge: 24 * 60 * 60 * 1000,
		});

		res.json({ admin: foundAdmin, accessToken });
	});
};

export const handleGetProviderAccountRequests = async (req: Request, res: Response) => {
	try {
		// Fetch pending provider account requests
		const providerAccountRequests = await ProviderApplicationModel.find({
			status: "pending",
		}).exec();

		// Generate signed URLs for each file
		const modifiedRequests = await Promise.all(
			providerAccountRequests.map(async (request) => {
				const signedUrls = await Promise.all([
					generateSignedUrl(request.id),
					generateSignedUrl(request.dbs),
					generateSignedUrl(request.resume),
					generateSignedUrl(request.profile),
				]);

				return {
					...request.toObject(),
					id: signedUrls[0],
					dbs: signedUrls[1],
					resume: signedUrls[2],
					profile: signedUrls[3],
				};
			}),
		);

		// Send modified requests with signed URLs
		res.status(200).json(modifiedRequests);
	} catch (error) {
		console.error("Error getting provider account requests:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

export const handleGetProviderAccountRequestsComplete = async (req: Request, res: Response) => {
	try {
		// Fetch pending provider account requests
		const providerAccountRequests = await ProviderApplicationModel.find({
			status: { $ne: "pending" },
		}).exec();

		// Generate signed URLs for each file
		const modifiedRequests = await Promise.all(
			providerAccountRequests.map(async (request) => {
				const signedUrls = await Promise.all([
					generateSignedUrl(request.id),
					generateSignedUrl(request.dbs),
					generateSignedUrl(request.resume),
					generateSignedUrl(request.profile),
				]);

				return {
					...request.toObject(),
					id: signedUrls[0],
					dbs: signedUrls[1],
					resume: signedUrls[2],
					profile: signedUrls[3],
				};
			}),
		);

		// Send modified requests with signed URLs
		res.status(200).json(modifiedRequests);
	} catch (error) {
		console.error("Error getting provider account requests:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

async function generateSignedUrl(filePath: string): Promise<string> {
	const options: GetSignedUrlConfig = {
		version: "v4",
		action: "read",
		expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 365 days
	};

	try {
		const [url] = await googleStorage.bucket(providerAccountBucket).file(filePath).getSignedUrl(options);
		return url;
	} catch (error) {
		console.error(`Error generating signed URL for file ${filePath}:`, error);
		throw error;
	}
}

export const handleUpdateProviderAccountRequestStatus = async (req: Request, res: Response) => {
	try {
		const { providerAccountRequestId, status, message } = req.body;
		const providerAccountRequest = await ProviderApplicationModel.findById(providerAccountRequestId).exec();

		if (!providerAccountRequest) return res.status(404).json({ message: "Provider account request not found" });

		providerAccountRequest.status = status;
		providerAccountRequest.rejectReason = message;

		await providerAccountRequest.save();

		const user = (await UserModel.findOne({ providerApplications: providerAccountRequestId }).exec()) as any;
		if (user) {
			const profileFilePath = providerAccountRequest.profile;
			const userId = user._id.toString();
			const fileExtension = path.extname(profileFilePath);

			const destinationPath = `${userId}/profile${fileExtension}`;

			try {
				await googleStorage
					.bucket(providerAccountBucket)
					.file(profileFilePath)
					.copy(googleStorage.bucket(userProfilesBucket).file(destinationPath));
			} catch (error) {
				console.error(`Error copying file to ${destinationPath}:`, error);
				throw error;
			}
			user.profile = destinationPath;
			user.providerStatus = status;
			await user.save();
		}

		res.status(200).json("Provider account request and user status updated successfully");
	} catch (error) {
		console.error("Error updating provider account request status:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};
