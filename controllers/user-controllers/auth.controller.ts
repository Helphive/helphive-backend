import { NextFunction, Request, Response } from "express";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { validationResult } from "express-validator";
import UserModel from "../../dal/models/user.model";
import { oneSignalApi } from "../service-accounts/onesignal";
import mongoose from "mongoose";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import NotificationModel from "../../dal/models/notification.model";
import { googleCloudStorage, userProfilesBucket } from "../service-accounts/cloud-storage";
import {
	createGoogleCloudTaskPaymentTrigger,
	sendBookingCancelledNotification,
	sendBookingCompletedNotification,
} from "./utils/auth.utils";
import { SAFE_USER_SELECT, isValidObjectId } from "./utils/booking.utils";
import { createSession, endSession, refreshSession, toPublicUser } from "./utils/session.utils";
import { createCometChatUser, updateCometChatUser } from "./utils/cometchat.util";
import stripe from "../service-accounts/stripe";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI, { AzureOpenAI } from "openai";
import { AZURE_OPENAI_API_VERSION, AZURE_OPENAI_BASE_URL, AZURE_OPENAI_DEPLOYMENT } from "../../config/config";

const emailVerificationSecret = process.env.EMAIL_VERIFICATION_SECRET || "";
const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID || "";

const googleGenerativeAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const googleGenerativeAIModel = googleGenerativeAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const azureOpenAIEndpoint = AZURE_OPENAI_BASE_URL;
const azureOpenAIApiKey = process.env.AZURE_OPENAI_API_KEY || "";
const azureOpenAIApiVersion = AZURE_OPENAI_API_VERSION;
const azureOpenAIDeployment = AZURE_OPENAI_DEPLOYMENT;
const azureOpenAIClient = new AzureOpenAI({
	endpoint: azureOpenAIEndpoint,
	apiKey: azureOpenAIApiKey,
	apiVersion: azureOpenAIApiVersion,
	deployment: azureOpenAIDeployment,
});

const openaiModel = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

export const handleSignup = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Invalid credentials.",
				errors: errors.array(),
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

		await createCometChatUser((newUser._id as string).toString(), email, `${firstName} ${lastName}`);

		next();
	} catch (error) {
		console.error("Error signing up:", error);
		res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleSignupProvider = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				message: "Invalid credentials.",
				errors: errors.array(),
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

		await createCometChatUser((newUser._id as string).toString(), email, `${firstName} ${lastName}`);

		next();
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
				message: "Email and password do not have a correct format.",
				errors: errors.array(),
			});
		}

		const { email, password } = req.body;

		const user = await UserModel.findOne({ email });
		if (!user) {
			return res.status(401).json({ message: "No user found with provided email." });
		}

		const passwordMatch = await bcrypt.compare(password, user.password);
		if (passwordMatch) {
			if (!user.isEmailVerified) {
				return res.status(403).json({ message: "Email is not verified." });
			}

			// Each login is its own session, so signing in on another device no longer signs this one out.
			const { accessToken, refreshToken: newRefreshToken } = await createSession(user);

			await handleOneSignalSetup(user);

			return res.json({ user: toPublicUser(user), accessToken, refreshToken: newRefreshToken });
		} else {
			return res.status(401).json({
				message: "Email and password do not match.",
			});
		}
	} catch (error) {
		console.error("Error logging in:", error);
		return res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleRefreshToken = async (req: Request, res: Response) => {
	const { refreshToken } = req.body;
	if (!refreshToken) return res.status(401).json({ message: "Unauthorized access!" });

	try {
		const result = await refreshSession(refreshToken);
		if (!result.ok) return res.status(result.status).json({ message: result.message });
		res.json({
			user: toPublicUser(result.user),
			accessToken: result.accessToken,
			refreshToken: result.refreshToken,
		});
	} catch (error) {
		console.error("Error refreshing session:", error);
		res.status(500).json({ message: "Internal server error!" });
	}
};

export const handleLogout = async (req: Request, res: Response) => {
	try {
		const { refreshToken } = req.body;
		if (!refreshToken) return res.sendStatus(204);
		await endSession(refreshToken);
		res.sendStatus(204);
	} catch (error) {
		console.error("Error during logout:", error);
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
				user,
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
		console.error("Error fetching user details:", error);
		return res.status(500).json({ message: "Internal Server Error" });
	}
};

export const handleVerifyEmail = async (req: Request, res: Response) => {
	const { token } = req.query;

	if (!token) {
		return res.status(400).json({ message: "Token is required" });
	}

	try {
		const secret = emailVerificationSecret;
		const decoded = jwt.verify(token as string, secret);
		const { userId } = decoded as { userId: string };

		const user = await UserModel.findById(userId);
		if (!user) {
			return res.status(400).json({ message: "Invalid token" });
		}

		if (user.isEmailVerified) {
			return res.status(400).json({ message: "Email already verified" });
		}

		const tokenIndex = user.emailVerificationTokens.findIndex((t: string) => t === token);
		if (tokenIndex === -1) {
			return res.status(400).json({ message: "Invalid or expired token" });
		}

		user.isEmailVerified = true;
		user.emailVerificationTokens = [];
		await user.save();

		res.status(200).json({ message: "Email verified successfully" });
	} catch (error) {
		if (error instanceof jwt.TokenExpiredError) {
			return res.status(400).json({ message: "Token has expired" });
		} else if (error instanceof jwt.JsonWebTokenError) {
			return res.status(400).json({ message: "Invalid token" });
		} else {
			res.status(500).json({ message: "Internal Server Error" });
		}
		console.error({ error });
	}
};

export const handleResetPassword = async (req: Request, res: Response) => {
	const { token } = req.body;

	if (!token) {
		return res.status(400).json({ message: "Token is required" });
	}

	try {
		const secret = emailVerificationSecret;
		const decoded = jwt.verify(token as string, secret);
		const { userId } = decoded as { userId: string };

		const user = await UserModel.findById(userId);
		if (!user) {
			return res.status(400).json({ message: "Invalid token" });
		}

		const tokenIndex = user.resetPasswordTokens.findIndex((t: string) => t === token);
		if (tokenIndex === -1) {
			return res.status(400).json({ message: "Invalid or expired token" });
		}

		const { password } = req.body;
		user.password = password;
		user.resetPasswordTokens = [];
		await user.save();

		res.status(200).json({ message: "Password reset successfully" });
	} catch (error) {
		if (error instanceof jwt.TokenExpiredError) {
			return res.status(400).json({ message: "Token has expired" });
		} else if (error instanceof jwt.JsonWebTokenError) {
			return res.status(400).json({ message: "Invalid token" });
		} else {
			res.status(500).json({ message: "Internal Server Error" });
		}
		console.error({ error });
	}
};

export const handleOneSignalSetup = async (user: any) => {
	try {
		await oneSignalApi.delete(`/apps/${ONE_SIGNAL_APP_ID}/users/by/external_id/${user._id}/identity/external_id`);
		console.log("Deleted OneSignal user with external ID:", user._id);
	} catch (error: any) {
		if (error.response && error.response.status !== 404) {
			console.error("Error setting up OneSignal:", error);
		}
	}
};

export const handleCompleteBooking = async (req: Request, res: Response) => {
	try {
		const userEmail = req.user;
		const user = (await UserModel.findOne({ email: userEmail })) as unknown as any;
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const { bookingId } = req.body;
		if (!bookingId) {
			return res.status(400).json({ message: "Booking ID is required." });
		}

		const booking =
			(await BookingModel.findById(bookingId).populate("providerId").populate("userId").exec()) || undefined;

		if (!booking || !booking.providerId || !booking.userId) {
			return res.status(404).json({ message: "Booking not found." });
		}

		if (
			![booking.userId._id.toString(), booking.providerId._id.toString()].includes((user as any)._id.toString())
		) {
			return res.status(403).json({ message: "User not authorized to complete this booking." });
		}

		if (booking.status !== "in progress") {
			return res.status(400).json({ message: "Booking is not in progress." });
		}

		const payment = await PaymentModel.findOne({ bookingId: booking._id });
		if (!payment || !payment.paymentIntentId) {
			return res.status(400).json({ message: "Payment not found for this booking." });
		}

		// REQUIRES ATTENTION
		// const fiveDaysFromNow = new Date();
		// fiveDaysFromNow.setDate(fiveDaysFromNow.getDate() + 5);
		const fiveMinutesFromNow = new Date();
		fiveMinutesFromNow.setSeconds(fiveMinutesFromNow.getSeconds() + 30);
		await createGoogleCloudTaskPaymentTrigger(bookingId, fiveMinutesFromNow);

		await EarningModel.create({
			bookingId: booking._id,
			amount: payment.amount * 0.95,
			date: new Date(),
		});

		booking.status = "completed";
		booking.completedAt = new Date();
		booking.completedBy = user._id;
		await booking.save();

		await sendBookingCompletedNotification(
			booking.userId._id?.toString(),
			booking.providerId._id?.toString(),
			booking,
		);

		res.status(200).json({ message: "Booking has been completed." });
	} catch (error) {
		console.error("Error completing job:", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleCancelBooking = async (req: Request, res: Response) => {
	try {
		const userEmail = req.user;
		const user = await UserModel.findOne({ email: userEmail });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const { bookingId } = req.body;
		if (!bookingId) {
			return res.status(400).json({ message: "Booking ID is required." });
		}

		const booking =
			(await BookingModel.findById(bookingId).populate("providerId").populate("userId").exec()) || undefined;

		if (!booking || !booking.userId) {
			return res.status(404).json({ message: "Booking not found." });
		}

		if (
			![booking.userId._id.toString(), booking.providerId?._id.toString()].includes((user as any)._id.toString())
		) {
			return res.status(403).json({ message: "User not authorized to cancel this booking." });
		}

		if (booking.status !== "pending") {
			return res
				.status(400)
				.json({ message: "Booking cannot be cancelled as it has already started or is not pending." });
		}

		booking.status = "cancelled";
		booking.cancelledAt = new Date();
		booking.cancelledBy = user._id as mongoose.Types.ObjectId;
		await booking.save();

		await sendBookingCancelledNotification(
			booking.userId._id?.toString(),
			booking.providerId ? booking.providerId._id.toString() : "",
			booking,
		);

		const payment = await PaymentModel.findOne({ bookingId: booking._id });
		if (payment && payment.paymentIntentId && payment.status === "completed") {
			const paymentIntent = await stripe.paymentIntents.retrieve(payment.paymentIntentId);
			if (paymentIntent.status === "succeeded") {
				const refund = await stripe.refunds.create({
					payment_intent: payment.paymentIntentId,
				});
				payment.refundStatus = "pending";
				payment.refundId = refund.id;
				payment.refundAmount = refund.amount / 100;
				payment.refundCreated = new Date(refund.created * 1000);
				payment.destinationDetails = {
					type: refund.destination_details?.type,
				};
				await payment.save();
			} else {
				console.log(`Payment intent ${payment.paymentIntentId} was not paid, no refund needed.`);
			}
		}

		res.status(200).json({ message: "Booking has been cancelled." });
	} catch (error) {
		console.error("Error cancelling booking:", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleUpdateProfile = async (req: Request, res: Response) => {
	try {
		const userEmail = req.user;
		const user = await UserModel.findOne({ email: userEmail });
		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const { firstName, lastName, phone, street, country, state, city } = req.body;

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
			const fileExtension = path.extname(profileFile.originalname);
			const destinationPath = `${userId}/profile${fileExtension}`;

			try {
				if (user.profile) {
					await googleCloudStorage.bucket(userProfilesBucket).file(user.profile).delete();
				}

				await googleCloudStorage.bucket(userProfilesBucket).file(destinationPath).save(profileFile.buffer);
				user.profile = destinationPath;
				await updateCometChatUser(userId, destinationPath);
			} catch (error) {
				console.error(`Error uploading profile image to ${destinationPath}:`, error);
				throw error;
			}
		}

		await user.save();

		res.status(200).json({ message: "Profile updated successfully." });
	} catch (error) {
		console.error("Error updating profile:", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};
export const handleGeminiChat = async (req: Request, res: Response) => {
	try {
		const { message } = req.body;
		const result = await googleGenerativeAIModel.generateContent(message);
		res.status(200).json({ message: result.response.text() });
	} catch (error) {
		console.error("Error generating chat:", error);
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
		console.error("Error fetching notifications:", error);
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
		console.error("Error fetching unread notification count:", error);
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
		console.error("Error marking all notifications as read:", error);
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
		console.error("Error deleting notification:", error);
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
			.populate("userId", SAFE_USER_SELECT)
			.populate("providerId", SAFE_USER_SELECT)
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
		const hasRefund = !!payment?.refundId;

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
							refundStatus: hasRefund ? payment.refundStatus : null,
							refundAmount: payment.refundAmount ?? 0,
							refundedAt:
								hasRefund && payment.refundStatus === "succeeded" ? payment.refundCreated : null,
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
		console.error("Error getting booking receipt:", error);
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
		if (notification.userId.toString() !== (user._id as string).toString()) {
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
		console.error("Error marking notification as read:", error);
		res.status(500).json({
			message: "An error occurred while processing request.",
		});
	}
};

export const handleAzureOpenAIChat = async (req: Request, res: Response) => {
	try {
		const { messages } = req.body;

		if (!Array.isArray(messages) || messages.some((msg) => !msg.role || !msg.content)) {
			return res.status(400).json({ message: "Invalid messages format." });
		}

		const result = await azureOpenAIClient.chat.completions.create({
			model: "gpt-4o",
			messages: messages,
		});

		res.status(200).json({ message: result.choices[0].message.content });
	} catch (error) {
		console.error("Error generating chat:", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};

export const handleOpenAIChat = async (req: Request, res: Response) => {
	try {
		const { messages } = req.body;

		if (!Array.isArray(messages) || messages.some((msg) => !msg.role || !msg.content)) {
			return res.status(400).json({ message: "Invalid messages format." });
		}

		const result = await openaiModel.chat.completions.create({
			model: "gpt-4o-mini",
			messages: messages,
		});

		res.status(200).json({ message: result.choices[0].message.content });
	} catch (error) {
		console.error("Error generating chat:", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};
