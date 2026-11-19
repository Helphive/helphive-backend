import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import NotionMagicLinkEmail from "../emails/verificationEmail";
import NotionResetPasswordEmail from "../emails/resetPasswordEmail";
import UserModel from "../dal/models/user.model";
import { CLIENT_BASE_URL, VERIFICATION_EMAIL } from "../config/config";
import { isDemoAccountEmail } from "../config/demoAccounts";
import { addEmailToken } from "./user-controllers/utils/token.utils";
import { addAudienceContact, sendEmail } from "../lib/email";
import { emitEvent } from "../lib/events";
import log from "../lib/logger";

const verificationEmail = VERIFICATION_EMAIL;

const VERIFY_EMAIL_TOKEN_TTL = "1d";
const RESET_PASSWORD_TOKEN_TTL = "1h";

/** The email from the body when it is a plain string, else null (objects would act as query operators). */
const emailFromBody = (req: Request): string | null => {
	const { email } = req.body ?? {};
	return typeof email === "string" && email.length > 0 && email.length <= 255 ? email : null;
};

/**
 * Marks the request as part of sign-up. Only then may a failure to reach Resend remove the account that was just
 * created; a resend request must never delete anyone.
 */
export const markSignupFlow = (req: Request, res: Response, next: NextFunction) => {
	res.locals.isSignup = true;
	next();
};

/** Adds the new account to the Resend audience. An address the recipient policy blocks is skipped, not added. */
export const createContact = async (req: Request, res: Response, next: NextFunction) => {
	const { firstName, lastName, email } = req.body;
	try {
		const result = await addAudienceContact({ email, firstName, lastName });
		if (result.status === "failed") {
			if (res.locals.isSignup) await UserModel.findOneAndDelete({ email, isEmailVerified: false });
			throw new Error(result.error);
		}
		next();
	} catch (error) {
		log.error("Error creating email contact", error);
		res.status(500).json({ message: "Internal Server Error" });
	}
};

/**
 * Sends (or resends) the verification link. For an address the recipient policy blocks, the answer is the same as for
 * any other address but nothing is sent, so the response reveals nothing about the policy.
 */
export const sendMagicLinkEmail = async (req: Request, res: Response) => {
	const email = emailFromBody(req);
	if (!email) {
		return res.status(400).json({ message: "Email is required" });
	}
	try {
		const user = await UserModel.findOne({ email });
		if (!user) {
			return res.status(404).json({ message: "User not found" });
		}
		if (user.isEmailVerified) {
			return res.status(400).json({ message: "Email already verified" });
		}

		const token = generateEmailLinkToken(String(user._id), user.email, "verify-email", VERIFY_EMAIL_TOKEN_TTL);
		const verificationLink = `${CLIENT_BASE_URL}/auth/verify-email?token=${token}`;

		user.emailVerificationTokens = addEmailToken(user.emailVerificationTokens, token);
		await user.save();

		const result = await sendEmail({
			template: "verify-email",
			from: `Helphive <${verificationEmail}>`,
			to: user.email,
			subject: "Verify Your Email",
			react: NotionMagicLinkEmail({ loginCode: verificationLink, verificationLink }),
			userId: String(user._id),
		});
		if (result.status === "failed") {
			if (res.locals.isSignup) await UserModel.findOneAndDelete({ _id: user._id, isEmailVerified: false });
			throw new Error(result.error);
		}
		res.status(201).json({ message: "Verification email sent" });
	} catch (error) {
		log.error("Error sending verification email", error);
		res.status(500).json({ message: "Internal Server Error" });
	}
};

export const sendResetPasswordEmail = async (req: Request, res: Response) => {
	const email = emailFromBody(req);
	if (!email) {
		return res.status(400).json({ message: "Email is required" });
	}
	// Same success response as a real request, but no token is stored and no email goes out.
	if (isDemoAccountEmail(email)) {
		emitEvent({ type: "security.demo_account_blocked", properties: { action: "password_reset_request" } }, req);
		return res.status(201).json({ message: "Verification email sent" });
	}
	try {
		const user = await UserModel.findOne({ email });
		if (!user) {
			return res.status(404).json({ message: "User not found" });
		}

		const token = generateEmailLinkToken(String(user._id), user.email, "reset-password", RESET_PASSWORD_TOKEN_TTL);
		const verificationLink = `${CLIENT_BASE_URL}/auth/reset-password?token=${token}`;

		user.resetPasswordTokens = addEmailToken(user.resetPasswordTokens, token);
		await user.save();

		// A blocked address gets the same answer as any other, with nothing sent (see sendMagicLinkEmail).
		const result = await sendEmail({
			template: "reset-password",
			from: `Helphive <${verificationEmail}>`,
			to: user.email,
			subject: "Reset Your Password",
			react: NotionResetPasswordEmail({ loginCode: verificationLink, verificationLink }),
			userId: String(user._id),
		});
		if (result.status === "failed") {
			throw new Error(result.error);
		}
		emitEvent(
			{
				type: "auth.password_reset_requested",
				subjects: { userId: user._id },
				properties: { emailSent: result.status === "sent" },
			},
			req,
		);
		res.status(201).json({ message: "Verification email sent" });
	} catch (error) {
		log.error("Error sending password reset email", error);
		res.status(500).json({ message: "Internal Server Error" });
	}
};

const generateEmailLinkToken = (
	userId: string,
	email: string,
	purpose: "verify-email" | "reset-password",
	expiresIn: string,
) => {
	const secret = process.env.EMAIL_VERIFICATION_SECRET || "";
	return jwt.sign({ userId, email, purpose }, secret, { expiresIn, algorithm: "HS256" } as jwt.SignOptions);
};
