import { NextFunction, Request, Response } from "express";
import path from "path";
import bcrypt from "bcrypt";
import jwt, { VerifyErrors } from "jsonwebtoken";
import { validationResult } from "express-validator";
import UserModel from "../../dal/models/user.model";
import { oneSignalApi } from "../service-accounts/onesignal";
import mongoose from "mongoose";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import { googleCloudStorage, userProfilesBucket } from "../service-accounts/cloud-storage";
import {
	createGoogleCloudTaskPaymentTrigger,
	sendBookingCancelledNotification,
	sendBookingCompletedNotification,
} from "./utils/auth.utils";

const accessTokenKey = process.env.ACCESS_TOKEN_SECRET || "";
const refreshTokenKey = process.env.REFRESH_TOKEN_SECRET || "";
const emailVerificationSecret = process.env.EMAIL_VERIFICATION_SECRET || "";
const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID || "";

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

			// Generate a new sessionId for the user
			user.sessionId = new mongoose.Types.ObjectId().toString();
			await user.save();

			const accessToken = jwt.sign(
				{
					UserInfo: {
						email: user.email,
						roles: user.roles,
						sessionId: user.sessionId,
					},
				},
				accessTokenKey,
				{ expiresIn: "10 minutes" },
			);
			const newRefreshToken = jwt.sign(
				{
					UserInfo: {
						email: user.email,
						roles: user.roles,
						sessionId: user.sessionId,
					},
				},
				refreshTokenKey,
				{ expiresIn: "30d" },
			);

			user.refreshToken = [newRefreshToken];
			await user.save();

			await handleOneSignalSetup(user);

			return res.json({ user, accessToken, refreshToken: newRefreshToken });
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
		const foundUser = await UserModel.findOne({
			refreshToken: refreshToken,
		}).exec();

		if (!foundUser) {
			jwt.verify(refreshToken, refreshTokenKey, async (error: VerifyErrors | null, decoded: any) => {
				if (error) return res.status(403).json({ message: "Error MIGHT be forbidden!" });

				const hackedUser = await UserModel.findOne({ email: decoded.email });
				if (hackedUser) {
					hackedUser.refreshToken = [];
					await hackedUser.save();
				}
			});
			return res.status(403).json({ message: "It is not forbidden!" });
		}

		try {
			const decoded: any = await new Promise((resolve, reject) => {
				jwt.verify(refreshToken, refreshTokenKey, (error: VerifyErrors | null, decoded: any) => {
					if (error) reject(error);
					else resolve(decoded);
				});
			});

			if (foundUser.email !== decoded?.UserInfo?.email || foundUser.sessionId !== decoded?.UserInfo?.sessionId) {
				foundUser.refreshToken = [];
				await foundUser.save();
				return res.status(403).json({ message: "Error is here forbidden!" });
			}

			// Invalidate the current refresh token
			foundUser.refreshToken = [];
			await foundUser.save();

			const accessToken = jwt.sign(
				{
					UserInfo: {
						email: decoded.UserInfo.email,
						roles: foundUser.roles,
						sessionId: foundUser.sessionId,
					},
				},
				accessTokenKey,
				{ expiresIn: "10 minutes" },
			);

			const newRefreshToken = jwt.sign(
				{
					UserInfo: {
						email: decoded.UserInfo.email,
						roles: foundUser.roles,
						sessionId: foundUser.sessionId,
					},
				},
				refreshTokenKey,
				{ expiresIn: "30d" },
			);

			// Store the new refresh token
			foundUser.refreshToken = [newRefreshToken];
			await foundUser.save();
			res.json({
				user: foundUser,
				accessToken,
				refreshToken: newRefreshToken,
			});
		} catch (error) {
			console.log(error);
			foundUser.refreshToken = [];
			await foundUser.save();
			return res.status(403).json({ message: "WTF forbidden!" });
		}
	} catch (error) {
		console.log(error);
		res.status(500).json({ message: "Internal server error!" });
	}
};

export const handleLogout = async (req: Request, res: Response) => {
	try {
		const { refreshToken } = req.body;
		if (!refreshToken) return res.sendStatus(204);

		const foundUser = await UserModel.findOne({ refreshToken }).exec();
		if (!foundUser) {
			return res.sendStatus(204);
		}

		foundUser.sessionId = "";
		foundUser.refreshToken = foundUser.refreshToken.filter((rt) => rt !== refreshToken);
		await foundUser.save();
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
		fiveMinutesFromNow.setMinutes(fiveMinutesFromNow.getMinutes() + 5);
		await createGoogleCloudTaskPaymentTrigger(bookingId, fiveMinutesFromNow);

		await EarningModel.create({
			bookingId: booking._id,
			amount: payment.amount * 0.8,
			date: new Date(),
		});

		booking.status = "completed";
		booking.completedAt = new Date();
		await booking.save();

		await sendBookingCompletedNotification(
			booking.userId._id?.toString(),
			booking.providerId._id?.toString(),
			bookingId,
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

		if (!booking || !booking.providerId || !booking.userId) {
			return res.status(404).json({ message: "Booking not found." });
		}

		if (
			![booking.userId._id.toString(), booking.providerId._id.toString()].includes((user as any)._id.toString())
		) {
			return res.status(403).json({ message: "User not authorized to cancel this booking." });
		}

		if (booking.status !== "pending") {
			return res
				.status(400)
				.json({ message: "Booking cannot be cancelled as it has already started or is not pending." });
		}

		booking.status = "cancelled";
		await booking.save();

		await sendBookingCancelledNotification(
			booking.userId._id?.toString(),
			booking.providerId._id?.toString(),
			bookingId,
		);

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
