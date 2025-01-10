import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { validationResult } from "express-validator";
import { GetSignedUrlConfig } from "@google-cloud/storage";
import { googleCloudStorage, providerAccountBucket, userProfilesBucket } from "./service-accounts/cloud-storage";
import { updateCometChatUser } from "./user-controllers/utils/cometchat.util";

import Admin from "../dal/models/admin.model";
import ProviderApplicationModel from "../dal/models/providerapplication.model";
import UserModel from "../dal/models/user.model";
import path from "path";

const accessTokenKey = process.env.ACCESS_TOKEN_SECRET || "";

export const handleSignup = async (req: Request, res: Response) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Email and password are required.",
				errors: errors.array(),
			});
		}

		const { firstName, lastName, email, password } = req.body;

		const existingAdmin = await Admin.findOne({ email });
		if (existingAdmin) {
			return res.status(409).json({ message: "Admin already exists" });
		}

		const hashedPassword = await bcrypt.hash(password, 10);

		const newAdmin = new Admin({
			firstName,
			lastName,
			email,
			password: hashedPassword,
			roles: {
				admin: true,
				superAdmin: false,
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
				message: "Email and password are required.",
				errors: errors.array(),
			});
		}
		const { email, password } = req.body;

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
				{ expiresIn: "30d" },
			);

			res.json({ admin, accessToken });
		} else {
			res.sendStatus(401);
		}
	} catch (error) {
		console.error("Error logging in:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

export const handleGetAccount = async (req: Request, res: Response) => {
	try {
		const { user } = req.body;
		const foundAdmin = await Admin.findOne({ email: user.email });
		res.json({ user: foundAdmin });
	} catch (error) {
		console.error("Error getting account:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

export const handleGetProviderAccountRequests = async (req: Request, res: Response) => {
	try {
		const providerAccountRequests = await ProviderApplicationModel.find({
			status: "pending",
		}).exec();

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
		const [url] = await googleCloudStorage.bucket(providerAccountBucket).file(filePath).getSignedUrl(options);
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
				await googleCloudStorage
					.bucket(providerAccountBucket)
					.file(profileFilePath)
					.copy(googleCloudStorage.bucket(userProfilesBucket).file(destinationPath));
			} catch (error) {
				console.error(`Error copying file to ${destinationPath}:`, error);
				throw error;
			}
			user.profile = destinationPath;
			user.providerStatus = status;
			user.phone = providerAccountRequest.phone;
			user.country = providerAccountRequest.country.toLowerCase();
			user.state = providerAccountRequest.state.toLowerCase();
			user.city = providerAccountRequest.city.toLowerCase();
			user.street = providerAccountRequest.street.toLowerCase();
			await user.save();
			await updateCometChatUser(userId, destinationPath);
		}

		res.status(200).json("Provider account request and user status updated successfully");
	} catch (error) {
		console.error("Error updating provider account request status:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};
