import { Request, Response } from "express";
import bcrypt from "bcrypt";
import { validationResult } from "express-validator";
import { GetSignedUrlConfig } from "@google-cloud/storage";
import { googleCloudStorage, providerAccountBucket, userProfilesBucket } from "./service-accounts/cloud-storage";
import { updateCometChatUser } from "./user-controllers/utils/cometchat.util";

import Admin from "../dal/models/admin.model";
import ProviderApplicationModel from "../dal/models/providerapplication.model";
import UserModel from "../dal/models/user.model";
import { sendNotification, storeNotification } from "./service-accounts/onesignal";
import path from "path";
import { isActiveAdmin, signAdminToken } from "../middleware/verifyAdminJWT";
import { publicValidationErrors } from "../middleware/sanitizeInput";
import { recordSuccessfulSignIn } from "../middleware/rateLimit";

const ADMIN_BCRYPT_ROUNDS = 12;
const DUMMY_ADMIN_HASH = bcrypt.hashSync("helphive-dummy-admin-password", ADMIN_BCRYPT_ROUNDS);
// Signed links to provider documents (ID, DBS check, CV) stay valid this long after the list is loaded.
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;

/** Creates an admin. Only a signed-in super admin may; new admins never get the super admin role here. */
export const handleSignup = async (req: Request, res: Response) => {
	try {
		if (!req.admin?.roles?.superAdmin) {
			return res.status(403).json({ message: "Only a super admin can create admin accounts." });
		}
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Email and password are required.",
				errors: publicValidationErrors(errors),
			});
		}

		const { firstName, lastName, email, password } = req.body;

		const existingAdmin = await Admin.findOne({ email });
		if (existingAdmin) {
			return res.status(409).json({ message: "Admin already exists" });
		}

		const hashedPassword = await bcrypt.hash(password, ADMIN_BCRYPT_ROUNDS);

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
		res.status(500).json({ message: "Internal server error" });
	}
};

export const handleLogin = async (req: Request, res: Response) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Email and password are required.",
				errors: publicValidationErrors(errors),
			});
		}
		const { email, password } = req.body;

		// Same response and the same bcrypt work whether or not the admin exists.
		const admin = await Admin.findOne({ email });
		const passwordMatch = await bcrypt.compare(password, admin?.password ?? DUMMY_ADMIN_HASH);
		if (!admin || !passwordMatch || !isActiveAdmin(admin)) {
			return res.status(401).json({ message: "Invalid credentials" });
		}

		// Response shape unchanged for the admin app: { admin, accessToken } (the password hash is never serialised).
		// This address may now sign in to this account even while the per-account failure cap is exceeded.
		recordSuccessfulSignIn("admin", req);
		res.json({ admin, accessToken: signAdminToken(admin) });
	} catch (error) {
		console.error("Error logging in:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

/** Signs this admin out everywhere by invalidating every token issued so far. */
export const handleLogout = async (req: Request, res: Response) => {
	try {
		await Admin.updateOne({ _id: req.admin?._id }, { $inc: { tokenVersion: 1 } });
		res.sendStatus(204);
	} catch (error) {
		console.error("Error logging out admin:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

export const handleGetAccount = async (req: Request, res: Response) => {
	try {
		res.json({ user: req.admin });
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
		expires: Date.now() + SIGNED_URL_TTL_MS,
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
		const { providerAccountRequestId, status } = req.body;
		const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
		const existing = await ProviderApplicationModel.findById(providerAccountRequestId).exec();
		if (!existing) return res.status(404).json({ message: "Provider account request not found" });

		// Decide each application once, atomically, so two admins cannot both act on it. Only a rejection
		// records a reason; an approval leaves rejectReason alone.
		const update: Record<string, unknown> = { status, updatedAt: new Date() };
		if (status === "rejected") update.rejectReason = message;
		const providerAccountRequest = await ProviderApplicationModel.findOneAndUpdate(
			{ _id: existing._id, status: "pending" },
			{ $set: update },
			{ new: true },
		).exec();
		if (!providerAccountRequest) {
			return res.status(409).json({ message: "This application has already been reviewed." });
		}

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
			await sendAccountReviewNotification(userId, status, message);
		}

		res.status(200).json("Provider account request and user status updated successfully");
	} catch (error) {
		console.error("Error updating provider account request status:", error);
		res.status(500).json({ message: "Internal server error" });
	}
};

const sendAccountReviewNotification = async (userId: string, status: string, reason?: string) => {
	if (status !== "approved" && status !== "rejected") return;
	try {
		const approved = status === "approved";
		const title = approved ? "Provider account approved" : "Provider application not approved";
		const message = approved
			? "Your provider application was approved. You can now accept jobs on HelpHive."
			: `Your provider application was not approved.${reason ? ` Reason: ${reason}` : ""}`;
		const type = approved ? "account_approved" : "account_rejected";
		await sendNotification({
			include_aliases: { external_id: [userId] },
			headings: { en: title },
			contents: { en: message },
			data: { screen: "Home", type },
		});
		await storeNotification(title, message, userId, "Home", type);
	} catch (error) {
		console.error(`Error sending account review notification for user ID ${userId}:`, error);
	}
};
