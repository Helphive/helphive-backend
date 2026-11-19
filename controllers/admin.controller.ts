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
import { publicValidationErrors } from "../middleware/sanitizeInput";
import { hasPermission, isDemoAdmin, legacyFlagsFor } from "../config/adminPermissions";
import { adminActor, recordAudit } from "../lib/audit";
import { emitEvent } from "../lib/events";
import log from "../lib/logger";
import { ADMIN_BCRYPT_ROUNDS } from "./admin/auth.controller";

// Signed links to provider documents (ID, DBS check, CV) stay valid this long after the list is loaded.
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;
// Provider application fields holding document paths; audit summaries show them as "[document]".
const APPLICATION_DOCUMENT_KEYS = ["id", "dbs", "resume", "profile"] as const;

/**
 * POST /admin/signup (kept for the current console): creates an operations admin with the password given. Requires
 * admins.manage (super admins). POST /admin/admins is the newer way, with a role and a one-time password.
 */
export const handleSignup = async (req: Request, res: Response) => {
	try {
		if (!req.admin || !hasPermission(req.admin, "admins.manage")) {
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
			role: "operations",
			roles: legacyFlagsFor("operations"),
			createdBy: req.admin._id,
		});
		await newAdmin.save();
		await recordAudit(
			{
				action: "admins.created",
				actor: adminActor(req),
				target: { type: "admin", id: newAdmin._id },
				after: { email, firstName, lastName, role: "operations" },
				metadata: { via: "signup" },
			},
			req,
		);

		res.status(201).json({ message: "Admin created successfully" });
	} catch (error) {
		log.error("Error creating admin", error);
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
				// The public demo admin never gets links to identity documents; the console shows "hidden in the demo".
				const signedUrls = isDemoAdmin(req.admin)
					? [null, null, null, null]
					: await Promise.all([
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
		log.error("Error getting provider account requests", error);
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
				// The public demo admin never gets links to identity documents; the console shows "hidden in the demo".
				const signedUrls = isDemoAdmin(req.admin)
					? [null, null, null, null]
					: await Promise.all([
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
		log.error("Error getting provider account requests", error);
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
		log.error("Error generating a signed URL for a provider document", error);
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
		// records a reason; an approval leaves rejectReason alone. Who decided and when is kept on the application.
		const now = new Date();
		const reviewer = req.admin?._id ?? null;
		const update: Record<string, unknown> = { status, updatedAt: now, reviewedAt: now, reviewedBy: reviewer };
		if (status === "rejected") update.rejectReason = message;
		const providerAccountRequest = await ProviderApplicationModel.findOneAndUpdate(
			{ _id: existing._id, status: "pending" },
			{
				$set: update,
				$push: {
					decisions: {
						status,
						at: now,
						by: reviewer,
						byEmail: req.admin?.email ?? null,
						reason: status === "rejected" ? message : null,
					},
				},
			},
			{ new: true },
		).exec();
		if (!providerAccountRequest) {
			return res.status(409).json({ message: "This application has already been reviewed." });
		}
		await recordAudit(
			{
				action: status === "approved" ? "applications.approved" : "applications.rejected",
				actor: adminActor(req),
				target: { type: "provider_application", id: existing._id },
				before: { status: existing.status },
				after: { status, ...(status === "rejected" ? { rejectReason: message } : {}) },
				reason: status === "rejected" ? message : null,
				documentKeys: APPLICATION_DOCUMENT_KEYS,
			},
			req,
		);

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
				log.error(`Error copying file to ${destinationPath}`, error);
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
			emitEvent(
				{
					type: "provider.application_reviewed",
					subjects: { providerId: user._id, userId: user._id, applicationId: existing._id },
					properties: {
						decision: status,
						...(status === "rejected" ? { reason: message } : {}),
						waitedMs: now.getTime() - new Date(existing.createdAt).getTime(),
					},
				},
				req,
			);
			await updateCometChatUser(userId, destinationPath);
			await sendAccountReviewNotification(userId, status, message);
		}

		res.status(200).json("Provider account request and user status updated successfully");
	} catch (error) {
		log.error("Error updating provider account request status", error);
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
		log.error(`Error sending account review notification for user ID ${userId}`, error);
	}
};
