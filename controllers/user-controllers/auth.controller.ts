import { NextFunction, Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { validationResult } from "express-validator";
import UserModel from "../../dal/models/user.model";
import { oneSignalApi } from "../service-accounts/onesignal";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import NotificationModel from "../../dal/models/notification.model";
import { googleCloudStorage, userProfilesBucket } from "../service-accounts/cloud-storage";
import {
	createGoogleCloudTaskPaymentTrigger,
	refundPaymentIfPaid,
	sendBookingCancelledNotification,
	sendBookingCompletedNotification,
} from "./utils/auth.utils";
import { isValidObjectId } from "./utils/booking.utils";
import { COUNTERPARTY_SELECT } from "./utils/counterparty.utils";
import { hasRefund } from "./utils/payment.utils";
import { createSession, endAllSessions, endSession, refreshSession, toPublicUser } from "./utils/session.utils";
import { JWT_ALGORITHMS, isPendingEmailToken } from "./utils/token.utils";
import { createCometChatUser, updateCometChatUser } from "./utils/cometchat.util";
import { DEMO_ACCOUNT_BLOCKED_MESSAGE, isDemoAccountEmail } from "../../config/demoAccounts";
import { publicValidationErrors } from "../../middleware/sanitizeInput";
import { storedFileInfo } from "../../middleware/uploads";
import { recordSuccessfulSignIn } from "../../middleware/rateLimit";
import { emitEvent, userActorType } from "../../lib/events";
import { hashEmail } from "../../lib/redact";
import log from "../../lib/logger";

const emailVerificationSecret = process.env.EMAIL_VERIFICATION_SECRET || "";
const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID || "";

// Compared against when the email is unknown, so a missing account takes as long to reject as a wrong password.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("helphive-dummy-password", 10);
const LOGIN_FAILED_MESSAGE = "Email and password do not match.";

/** Purpose and user of an email-link token, or null when it is not a valid token for that purpose. */
const verifyEmailLinkToken = (token: unknown, purpose: "verify-email" | "reset-password") => {
	if (typeof token !== "string" || token.length > 2048) throw new jwt.JsonWebTokenError("invalid token");
	const decoded = jwt.verify(token, emailVerificationSecret, { algorithms: JWT_ALGORITHMS }) as any;
	// Links sent before purpose was added carry none; the per-purpose token list on the user still separates them.
	if (decoded?.purpose !== undefined && decoded.purpose !== purpose) throw new jwt.JsonWebTokenError("wrong purpose");
	if (!isValidObjectId(decoded?.userId)) throw new jwt.JsonWebTokenError("invalid token");
	return { token, userId: decoded.userId as string };
};

export const handleSignup = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Invalid credentials.",
				errors: publicValidationErrors(errors),
			});
		}

		const { firstName, lastName, email, password } = req.body;

		const existingUser = await UserModel.findOne({ email });
		if (existingUser && existingUser.roles.Provider) {
			return res.status(409).json({
				message: "A provider account already exists on this email. Please use a different one.",
			});
		} else if (existingUser && existingUser.roles.User) {
			return res.status(409).json({
				message: "An account already exists on this email. Please use a different one.",
			});
		}

		const newUser = new UserModel({
			firstName,
			lastName,
			email,
			password,
			roles: {
				User: true,
				Provider: false,
			},
		});
		await newUser.save();
		emitEvent(
			{
				type: "user.signed_up",
				actor: { type: "user", id: newUser._id },
				subjects: { userId: newUser._id },
				properties: { role: "customer" },
			},
			req,
		);

		await createCometChatUser(String(newUser._id), email, `${firstName} ${lastName}`);

		next();
	} catch (error) {
		log.error("Error signing up", error);
		res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleSignupProvider = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Invalid credentials.",
				errors: publicValidationErrors(errors),
			});
		}

		const { firstName, lastName, email, password } = req.body;

		const existingUser = await UserModel.findOne({ email });
		if (existingUser && existingUser.roles.Provider) {
			return res.status(409).json({
				message: "A provider account already exists on this email. Please use a different one.",
			});
		} else if (existingUser && existingUser.roles.User) {
			return res.status(409).json({
				message: "An account already exists on this email. Please use a different one.",
			});
		}

		const newUser = new UserModel({
			firstName,
			lastName,
			email,
			password,
			roles: {
				User: false,
				Provider: true,
			},
		});
		await newUser.save();
		emitEvent(
			{
				type: "user.signed_up",
				actor: { type: "provider", id: newUser._id },
				subjects: { userId: newUser._id, providerId: newUser._id },
				properties: { role: "provider" },
			},
			req,
		);

		await createCometChatUser(String(newUser._id), email, `${firstName} ${lastName}`);

		next();
	} catch (error) {
		log.error("Error signing up", error);
		res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleLogin = async (req: Request, res: Response) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Email and password do not have a correct format.",
				errors: publicValidationErrors(errors),
			});
		}

		const { email, password } = req.body;

		// The same answer, after the same bcrypt work, whether or not the account exists.
		const user = await UserModel.findOne({ email });
		const passwordMatch = await bcrypt.compare(password, user?.password ?? DUMMY_PASSWORD_HASH);
		const role = user?.roles?.Provider ? "provider" : "customer";
		if (user && passwordMatch) {
			if (!user.isEmailVerified) {
				emitEvent(
					{
						type: "auth.sign_in_failed",
						actor: { type: "anonymous" },
						subjects: { userId: user._id },
						properties: { reason: "email_unverified", emailHash: hashEmail(String(email)) },
					},
					req,
				);
				return res.status(403).json({ message: "Email is not verified." });
			}

			// Each login is its own session, so signing in on another device no longer signs this one out.
			const { accessToken, refreshToken: newRefreshToken } = await createSession(user);
			// This address may now sign in to this account even while the per-account failure cap is exceeded.
			recordSuccessfulSignIn("user", req);
			emitEvent(
				{
					type: "auth.sign_in_succeeded",
					actor: { type: userActorType(user), id: user._id },
					subjects: { userId: user._id, ...(user.roles?.Provider ? { providerId: user._id } : {}) },
					properties: { role },
				},
				req,
			);

			await handleOneSignalSetup(user);

			return res.json({ user: toPublicUser(user), accessToken, refreshToken: newRefreshToken });
		} else {
			emitEvent(
				{
					type: "auth.sign_in_failed",
					actor: { type: "anonymous" },
					subjects: { userId: user?._id },
					properties: { reason: "bad_credentials", emailHash: hashEmail(String(email)) },
				},
				req,
			);
			return res.status(401).json({ message: LOGIN_FAILED_MESSAGE });
		}
	} catch (error) {
		log.error("Error logging in", error);
		return res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleRefreshToken = async (req: Request, res: Response) => {
	const { refreshToken } = req.body;
	if (!refreshToken || typeof refreshToken !== "string") {
		return res.status(401).json({ message: "Unauthorized access!" });
	}

	try {
		const result = await refreshSession(refreshToken);
		if (!result.ok) return res.status(result.status).json({ message: result.message });
		res.json({
			user: toPublicUser(result.user),
			accessToken: result.accessToken,
			refreshToken: result.refreshToken,
		});
	} catch (error) {
		log.error("Error refreshing session", error);
		res.status(500).json({ message: "Internal server error!" });
	}
};

export const handleLogout = async (req: Request, res: Response) => {
	try {
		const { refreshToken } = req.body;
		if (!refreshToken || typeof refreshToken !== "string") return res.sendStatus(204);
		const user = await endSession(refreshToken);
		if (user) {
			emitEvent(
				{
					type: "auth.signed_out",
					actor: { type: userActorType(user), id: user._id },
					subjects: { userId: user._id },
				},
				req,
			);
		}
		res.sendStatus(204);
	} catch (error) {
		log.error("Error during logout", error);
		res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleGetUserInfo = async (req: Request, res: Response) => {
	try {
		const email = req.user;
		const user = await UserModel.findOne({ email }).populate("providerApplications");
		if (user) {
			const { email, firstName, lastName, roles, profile } = user;
			const requests: any = user.providerApplications;
			const status = user.providerStatus;

			let rejectReason = "";
			if (status === "rejected") {
				const rejectedRequests = requests
					.filter((request: any) => request.status === "rejected")
					.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
				if (rejectedRequests.length > 0) {
					rejectReason = rejectedRequests[0].rejectReason;
				}
			}

			let jobTypes: any = {
				publicAreaAttendant: false,
				roomAttendant: false,
				linenPorter: false,
			};

			if (status == "approved") {
				const approvedRequest = requests.find((request: any) => request.status === "approved");
				if (approvedRequest) {
					jobTypes = approvedRequest.jobTypes;
				}
			}

			return res.status(200).json({
				user: toPublicUser(user),
				email,
				firstName,
				lastName,
				roles,
				profile,
				status,
				rejectReason,
				jobTypes,
				accountApprovalScreen: user.providerAccountApproval,
			});
		} else {
			return res.status(404).json({ message: "User not found" });
		}
	} catch (error) {
		log.error("Error fetching user details", error);
		return res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleVerifyEmail = async (req: Request, res: Response) => {
	const { token } = req.query;

	if (!token) {
		return res.status(400).json({ message: "Token is required" });
	}

	try {
		const { userId } = verifyEmailLinkToken(token, "verify-email");

		const user = await UserModel.findById(userId);
		if (!user) {
			return res.status(400).json({ message: "Invalid token" });
		}

		if (user.isEmailVerified) {
			return res.status(400).json({ message: "Email already verified" });
		}

		if (!isPendingEmailToken(user.emailVerificationTokens, token as string)) {
			return res.status(400).json({ message: "Invalid or expired token" });
		}

		user.isEmailVerified = true;
		user.emailVerificationTokens = [];
		await user.save();
		emitEvent(
			{
				type: "user.email_verified",
				actor: { type: userActorType(user), id: user._id },
				subjects: { userId: user._id },
			},
			req,
		);

		res.status(200).json({ message: "Email verified successfully" });
	} catch (error) {
		if (error instanceof jwt.TokenExpiredError) {
			return res.status(400).json({ message: "Token has expired" });
		} else if (error instanceof jwt.JsonWebTokenError) {
			return res.status(400).json({ message: "Invalid token" });
		}
		log.error("Error verifying email", error);
		res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleResetPassword = async (req: Request, res: Response) => {
	const errors = validationResult(req);
	if (!errors.isEmpty()) {
		return res.status(400).json({ message: errors.array()[0].msg, errors: publicValidationErrors(errors) });
	}

	const { token, password } = req.body;

	try {
		const { userId } = verifyEmailLinkToken(token, "reset-password");

		const user = await UserModel.findById(userId);
		if (!user) {
			return res.status(400).json({ message: "Invalid token" });
		}

		if (isDemoAccountEmail(user.email)) {
			emitEvent(
				{
					type: "security.demo_account_blocked",
					subjects: { userId: user._id },
					properties: { action: "password_reset" },
				},
				req,
			);
			return res.status(403).json({ message: DEMO_ACCOUNT_BLOCKED_MESSAGE });
		}

		if (!isPendingEmailToken(user.resetPasswordTokens, token)) {
			return res.status(400).json({ message: "Invalid or expired token" });
		}

		// Claim every pending link atomically so a token works once even when submitted twice at the same time.
		const claimed = await UserModel.updateOne(
			{ _id: user._id, resetPasswordTokens: { $in: user.resetPasswordTokens } },
			{ $set: { resetPasswordTokens: [] } },
		);
		if (claimed.modifiedCount !== 1) {
			return res.status(400).json({ message: "Invalid or expired token" });
		}

		user.password = password;
		user.resetPasswordTokens = [];
		// Whoever knew the old password is signed out everywhere.
		endAllSessions(user);
		await user.save();
		emitEvent(
			{
				type: "auth.password_reset_completed",
				actor: { type: userActorType(user), id: user._id },
				subjects: { userId: user._id },
			},
			req,
		);

		res.status(200).json({ message: "Password reset successfully" });
	} catch (error) {
		if (error instanceof jwt.TokenExpiredError) {
			return res.status(400).json({ message: "Token has expired" });
		} else if (error instanceof jwt.JsonWebTokenError) {
			return res.status(400).json({ message: "Invalid token" });
		}
		log.error("Error resetting password", error);
		res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleOneSignalSetup = async (user: any) => {
	try {
		await oneSignalApi.delete(`/apps/${ONE_SIGNAL_APP_ID}/users/by/external_id/${user._id}/identity/external_id`);
		log.info(`Deleted OneSignal user with external ID ${user._id}`);
	} catch (error: any) {
		if (error.response && error.response.status !== 404) {
			log.error("Error setting up OneSignal", error);
		}
	}
};

export const handleCompleteBooking = async (req: Request, res: Response) => {
	try {
		const user = await UserModel.findOne({ email: req.user });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const { bookingId } = req.body;
		if (!bookingId) {
			return res.status(400).json({ message: "Booking ID is required." });
		}
		if (!isValidObjectId(bookingId)) {
			return res.status(400).json({ message: "Invalid booking id." });
		}

		const booking = await BookingModel.findById(bookingId).exec();
		if (!booking || !booking.providerId || !booking.userId) {
			return res.status(404).json({ message: "Booking not found." });
		}

		const requesterId = String(user._id);
		if (![booking.userId.toString(), booking.providerId.toString()].includes(requesterId)) {
			return res.status(403).json({ message: "User not authorized to complete this booking." });
		}

		if (booking.status !== "in progress") {
			return res.status(400).json({ message: "Booking is not in progress." });
		}

		const payment = await PaymentModel.findOne({ bookingId: booking._id });
		if (!payment || !payment.paymentIntentId) {
			return res.status(400).json({ message: "Payment not found for this booking." });
		}

		// Claim the transition atomically: a double tap or both parties completing at once creates one earning.
		const completed = await BookingModel.findOneAndUpdate(
			{ _id: booking._id, status: "in progress" },
			{ $set: { status: "completed", completedAt: new Date(), completedBy: user._id } },
			{ new: true },
		).exec();
		if (!completed) {
			return res.status(400).json({ message: "Booking is not in progress." });
		}

		let earning: InstanceType<typeof EarningModel> | null = null;
		let releaseAt: Date;
		try {
			earning = await EarningModel.create({
				bookingId: booking._id,
				amount: payment.amount * 0.95,
				date: new Date(),
			});
			// REQUIRES ATTENTION: earnings are released 30 seconds after completion (meant to be several days).
			releaseAt = new Date(Date.now() + 30 * 1000);
			await createGoogleCloudTaskPaymentTrigger(String(booking._id), releaseAt);
		} catch (error) {
			// Without its release task the earning would never be paid; put the booking back so it can be retried.
			await BookingModel.updateOne(
				{ _id: booking._id, status: "completed" },
				{ $set: { status: "in progress", completedAt: null, completedBy: null } },
			);
			if (earning) await EarningModel.deleteOne({ _id: earning._id });
			throw error;
		}

		const subjects = { userId: booking.userId, providerId: booking.providerId, bookingId: booking._id };
		const completedBy = requesterId === booking.userId.toString() ? "customer" : "provider";
		emitEvent(
			{
				type: "booking.completed",
				actor: { type: completedBy === "customer" ? "user" : "provider", id: user._id },
				subjects,
				properties: {
					by: completedBy,
					durationMs: completed.startedAt
						? completed.completedAt.getTime() - completed.startedAt.getTime()
						: null,
					bookedHours: completed.hours,
				},
			},
			req,
		);
		emitEvent(
			{
				type: "earning.created",
				actor: { type: "system" },
				subjects: { ...subjects, earningId: earning._id },
				properties: { amount: earning.amount, releaseAt },
			},
			req,
		);

		await sendBookingCompletedNotification(booking.userId.toString(), booking.providerId.toString(), completed);

		res.status(200).json({ message: "Booking has been completed." });
	} catch (error) {
		log.error("Error completing job", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleCancelBooking = async (req: Request, res: Response) => {
	try {
		const user = await UserModel.findOne({ email: req.user });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const { bookingId } = req.body;
		if (!bookingId) {
			return res.status(400).json({ message: "Booking ID is required." });
		}
		if (!isValidObjectId(bookingId)) {
			return res.status(400).json({ message: "Invalid booking id." });
		}

		const booking = await BookingModel.findById(bookingId).exec();
		if (!booking || !booking.userId) {
			return res.status(404).json({ message: "Booking not found." });
		}

		const requesterId = String(user._id);
		if (![booking.userId.toString(), booking.providerId?.toString()].includes(requesterId)) {
			return res.status(403).json({ message: "User not authorized to cancel this booking." });
		}

		const notPending = { message: "Booking cannot be cancelled as it has already started or is not pending." };
		if (booking.status !== "pending") {
			return res.status(400).json(notPending);
		}

		const cancelled = await BookingModel.findOneAndUpdate(
			{ _id: booking._id, status: "pending" },
			{ $set: { status: "cancelled", cancelledAt: new Date(), cancelledBy: user._id } },
			{ new: true },
		).exec();
		if (!cancelled) {
			return res.status(400).json(notPending);
		}

		const cancelledBy = requesterId === booking.userId.toString() ? "customer" : "provider";
		emitEvent(
			{
				type: "booking.cancelled",
				actor: { type: cancelledBy === "customer" ? "user" : "provider", id: user._id },
				subjects: { userId: cancelled.userId, providerId: cancelled.providerId, bookingId: cancelled._id },
				properties: {
					by: cancelledBy,
					reason: cancelled.cancellationReason ?? null,
					wasAccepted: !!cancelled.providerId,
				},
			},
			req,
		);

		await sendBookingCancelledNotification(
			cancelled.userId.toString(),
			cancelled.providerId ? cancelled.providerId.toString() : "",
			cancelled,
		);

		await refundPaymentIfPaid(String(cancelled._id));

		res.status(200).json({ message: "Booking has been cancelled." });
	} catch (error) {
		log.error("Error cancelling booking", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleUpdateProfile = async (req: Request, res: Response) => {
	const errors = validationResult(req);
	if (!errors.isEmpty()) {
		return res.status(400).json({ message: errors.array()[0].msg, errors: publicValidationErrors(errors) });
	}
	try {
		const userEmail = req.user;
		const user = await UserModel.findOne({ email: userEmail });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const { firstName, lastName, phone, street, country, state, city } = req.body;
		const changedFields = Object.entries({ firstName, lastName, phone, street, country, state, city })
			.filter(([, value]) => !!value)
			.map(([field]) => field);
		let photo = false;

		if (firstName) user.firstName = firstName;
		if (lastName) user.lastName = lastName;
		if (phone) user.phone = phone;
		if (street) user.street = street.toLowerCase();
		if (country) user.country = country.toLowerCase();
		if (state) user.state = state.toLowerCase();
		if (city) user.city = city.toLowerCase();

		if (req.files && (req.files as { [fieldname: string]: Express.Multer.File[] }).profile) {
			const profileFile = (req.files as { [fieldname: string]: Express.Multer.File[] }).profile[0];
			const userId = (user as any)._id.toString();
			const { extension, contentType } = storedFileInfo("profile", profileFile);
			const destinationPath = `${userId}/profile.${extension}`;

			try {
				if (user.profile && user.profile !== destinationPath) {
					await googleCloudStorage
						.bucket(userProfilesBucket)
						.file(user.profile)
						.delete({ ignoreNotFound: true });
				}

				await googleCloudStorage
					.bucket(userProfilesBucket)
					.file(destinationPath)
					.save(profileFile.buffer, { contentType, resumable: false });
				user.profile = destinationPath;
				photo = true;
				await updateCometChatUser(userId, destinationPath);
			} catch (error) {
				log.error(`Error uploading profile image to ${destinationPath}:`, error);
				throw error;
			}
		}

		await user.save();
		emitEvent(
			{
				type: "user.profile_updated",
				actor: { type: userActorType(user), id: user._id },
				subjects: { userId: user._id },
				properties: { fields: changedFields, photo },
			},
			req,
		);

		res.status(200).json({ message: "Profile updated successfully." });
	} catch (error) {
		log.error("Error updating profile", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};
const DEFAULT_NOTIFICATIONS_LIMIT = 20;
const MAX_NOTIFICATIONS_LIMIT = 50;

const serializeNotification = (notification: any) => {
	const rawBookingId = notification.bookingId ?? notification.data?.bookingId ?? null;
	return {
		_id: notification._id,
		title: notification.title,
		message: notification.message,
		type: notification.type || "general",
		screen: notification.screen,
		data: notification.data ?? {},
		bookingId: rawBookingId && isValidObjectId(rawBookingId.toString()) ? rawBookingId.toString() : null,
		read: notification.read,
		createdAt: notification.createdAt,
		updatedAt: notification.updatedAt,
	};
};

export const handleGetNotifications = async (req: Request, res: Response) => {
	try {
		const user = await UserModel.findOne({ email: req.user }).select("_id");
		if (!user) {
			return res.status(404).json({
				message: "User not found.",
			});
		}

		const { cursor, filter = "all" } = req.query;
		if (filter !== "all" && filter !== "unread") {
			return res.status(400).json({ message: "Invalid filter." });
		}
		if (cursor !== undefined && !isValidObjectId(cursor)) {
			return res.status(400).json({ message: "Invalid cursor." });
		}
		const parsedLimit = parseInt(req.query.limit as string, 10);
		const limit = Number.isNaN(parsedLimit)
			? DEFAULT_NOTIFICATIONS_LIMIT
			: Math.min(Math.max(parsedLimit, 1), MAX_NOTIFICATIONS_LIMIT);

		const userId = String(user._id);
		const query: Record<string, any> = { userId };
		if (filter === "unread") query.read = false;
		if (cursor) query._id = { $lt: cursor };

		const [items, unreadCount] = await Promise.all([
			NotificationModel.find(query)
				.sort({ _id: -1 })
				.limit(limit + 1)
				.lean()
				.exec(),
			NotificationModel.countDocuments({ userId, read: false }),
		]);

		const hasMore = items.length > limit;
		const page = hasMore ? items.slice(0, limit) : items;
		const nextCursor = hasMore ? String(page[page.length - 1]._id) : null;

		res.status(200).json({
			notifications: page.map(serializeNotification),
			nextCursor,
			hasMore,
			unreadCount,
		});
	} catch (error) {
		log.error("Error fetching notifications", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleGetUnreadNotificationCount = async (req: Request, res: Response) => {
	try {
		const user = await UserModel.findOne({ email: req.user }).select("_id");
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}
		const unreadCount = await NotificationModel.countDocuments({ userId: String(user._id), read: false });
		res.status(200).json({ unreadCount });
	} catch (error) {
		log.error("Error fetching unread notification count", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};

export const handleMarkAllNotificationsAsRead = async (req: Request, res: Response) => {
	try {
		const user = await UserModel.findOne({ email: req.user }).select("_id");
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}
		const result = await NotificationModel.updateMany({ userId: String(user._id), read: false }, { read: true });
		res.status(200).json({ modifiedCount: result.modifiedCount });
	} catch (error) {
		log.error("Error marking all notifications as read", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};

export const handleDeleteNotification = async (req: Request, res: Response) => {
	try {
		const { notificationId } = req.params;
		if (!isValidObjectId(notificationId)) {
			return res.status(400).json({ message: "Invalid notification id." });
		}
		const user = await UserModel.findOne({ email: req.user }).select("_id");
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}
		const notification = await NotificationModel.findById(notificationId);
		if (!notification) {
			return res.status(404).json({ message: "Notification not found." });
		}
		if (notification.userId.toString() !== String(user._id)) {
			return res.status(403).json({ message: "User not authorized to delete this notification." });
		}
		await notification.deleteOne();
		res.status(200).json({ message: "Notification deleted." });
	} catch (error) {
		log.error("Error deleting notification", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};

export const handleGetBookingReceipt = async (req: Request, res: Response) => {
	try {
		const { bookingId } = req.params;
		if (!isValidObjectId(bookingId)) {
			return res.status(400).json({ message: "Invalid booking id." });
		}
		const user = await UserModel.findOne({ email: req.user }).select("_id");
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const booking: any = await BookingModel.findById(bookingId)
			.populate("userId", COUNTERPARTY_SELECT)
			.populate("providerId", COUNTERPARTY_SELECT)
			.exec();
		if (!booking) {
			return res.status(404).json({ message: "Booking not found." });
		}

		const requesterId = String(user._id);
		const isCustomer = booking.userId?._id.toString() === requesterId;
		const isProvider = !!booking.providerId && booking.providerId._id.toString() === requesterId;
		if (!isCustomer && !isProvider) {
			return res.status(403).json({ message: "User not authorized to view this receipt." });
		}

		const [payment, earning] = await Promise.all([
			PaymentModel.findOne({ bookingId: booking._id }).sort({ createdAt: -1 }).exec(),
			isProvider ? EarningModel.findOne({ bookingId: booking._id }).exec() : null,
		]);

		const subtotal = booking.rate * booking.hours;
		// payment.date is set once when the payment is created; updatedAt would move on refunds.
		const paidAt = payment && payment.status === "completed" ? payment.date : null;
		const refunded = hasRefund(payment);

		res.status(200).json({
			receipt: {
				receiptNumber: `HH-${String(booking._id).slice(-8).toUpperCase()}`,
				issuedAt: paidAt ?? booking.createdAt,
				bookingId: String(booking._id),
				status: booking.status,
				service: { id: booking.service.id, name: booking.service.name },
				rate: booking.rate,
				hours: booking.hours,
				subtotal,
				total: payment ? payment.amount : subtotal,
				currency: "usd",
				payment: payment
					? {
							status: payment.status,
							amount: payment.amount,
							paidAt,
							refundStatus: refunded ? payment.refundStatus : null,
							refundAmount: refunded ? (payment.refundAmount ?? 0) : 0,
							refundedAt: refunded && payment.refundStatus === "succeeded" ? payment.refundCreated : null,
						}
					: null,
				customer: {
					name: `${booking.userId.firstName} ${booking.userId.lastName}`.trim(),
					email: booking.userId.email,
				},
				provider: booking.providerId
					? { name: `${booking.providerId.firstName} ${booking.providerId.lastName}`.trim() }
					: null,
				address: booking.address,
				startDate: booking.startDate,
				startedAt: booking.startedAt ?? null,
				completedAt: booking.completedAt ?? null,
				cancelledAt: booking.cancelledAt ?? null,
				cancellationReason: booking.cancellationReason ?? null,
				earning: isProvider && earning ? { amount: earning.amount, status: earning.status } : null,
			},
		});
	} catch (error) {
		log.error("Error getting booking receipt", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};

export const handleMarkNotificationAsRead = async (req: Request, res: Response) => {
	try {
		const { notificationId } = req.body;
		if (!notificationId) {
			return res.status(400).json({
				message: "Notification ID is required.",
			});
		}
		if (!isValidObjectId(notificationId)) {
			return res.status(400).json({ message: "Invalid notification id." });
		}
		const notification = await NotificationModel.findById(notificationId);
		if (!notification) {
			return res.status(404).json({
				message: "Notification not found.",
			});
		}
		const userEmail = req.user;
		const user = await UserModel.findOne({ email: userEmail });
		if (!user) {
			return res.status(404).json({
				message: "User not found.",
			});
		}
		if (notification.userId.toString() !== String(user._id)) {
			return res.status(403).json({
				message: "User not authorized to mark this notification as read.",
			});
		}
		notification.read = true;
		await notification.save();
		res.status(200).json({
			message: "Notification marked as read.",
		});
	} catch (error) {
		log.error("Error marking notification as read", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};
