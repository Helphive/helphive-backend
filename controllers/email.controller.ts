import { Request, Response, NextFunction } from "express";
import { Resend } from "resend";
import jwt from "jsonwebtoken";
import NotionMagicLinkEmail from "../emails/verificationEmail";
import NotionResetPasswordEmail from "../emails/resetPasswordEmail";
import UserModel from "../dal/models/user.model";
import { CLIENT_BASE_URL, VERIFICATION_EMAIL } from "../config/config";

const resend = new Resend(process.env.RESEND_API_KEY);
const resendAudienceId = process.env.RESEND_AUDIENCE_ID || "";
const verificationEmail = VERIFICATION_EMAIL;

export const createContact = async (req: Request, res: Response, next: NextFunction) => {
	const { firstName, lastName, email } = req.body;
	try {
		const response = await resend.contacts.create({
			email: email,
			firstName: firstName,
			lastName: lastName,
			unsubscribed: false,
			audienceId: resendAudienceId,
		});
		if (response.error) {
			await UserModel.findOneAndDelete({ email });
			throw new Error(`${response.error}`);
		}
		next();
	} catch (error) {
		console.error({ error });
		res.status(500).json({ message: "Internal Server Error" });
	}
};

export const sendMagicLinkEmail = async (req: Request, res: Response) => {
	const { email } = req.body;
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

		const token = generateVerificationToken(user?._id as string, user?.email || "");
		const verificationLink = `${CLIENT_BASE_URL}/auth/verify-email?token=${token}`;
		const baseUrl = CLIENT_BASE_URL || "";

		user.emailVerificationTokens.push(token);
		await user.save();

		const { data, error } = await resend.emails.send({
			from: `HelpHive <${verificationEmail}>`,
			to: [email],
			subject: "Verify Your Email",
			react: NotionMagicLinkEmail({ baseUrl: baseUrl, loginCode: verificationLink, verificationLink }),
		});
		if (error) {
			await UserModel.findOneAndDelete({ email });
			throw new Error(`${error}`);
		}
		res.status(201).json({ message: "Verification email sent", resendId: data });
	} catch (error) {
		res.status(500).json({ message: "Internal Server Error" });
		console.error({ error });
	}
};

export const sendResetPasswordEmail = async (req: Request, res: Response) => {
	const { email } = req.body;
	if (!email) {
		return res.status(400).json({ message: "Email is required" });
	}
	try {
		const user = await UserModel.findOne({ email });
		if (!user) {
			return res.status(404).json({ message: "User not found" });
		}

		const token = generateVerificationToken(user?._id as string, user?.email || "");
		const verificationLink = `${CLIENT_BASE_URL}/auth/reset-password?token=${token}`;
		const baseUrl = CLIENT_BASE_URL || "";

		user.resetPasswordTokens.push(token);
		await user.save();

		const { data, error } = await resend.emails.send({
			from: `HelpHive <${verificationEmail}>`,
			to: [email],
			subject: "Reset Your Password",
			react: NotionResetPasswordEmail({ baseUrl: baseUrl, loginCode: verificationLink, verificationLink }),
		});
		if (error) {
			throw new Error(`${error}`);
		}
		res.status(201).json({ message: "Verification email sent", resendId: data });
	} catch (error) {
		res.status(500).json({ message: "Internal Server Error" });
		console.error({ error });
	}
};

const generateVerificationToken = (userId: string, email: string) => {
	const payload = { userId, email };
	const secret = process.env.EMAIL_VERIFICATION_SECRET || "";
	return jwt.sign(payload, secret, { expiresIn: "1d" });
};
