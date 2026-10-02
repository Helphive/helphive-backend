import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import UserModel from "../../../dal/models/user.model";

const accessTokenKey = process.env.ACCESS_TOKEN_SECRET || "";
const refreshTokenKey = process.env.REFRESH_TOKEN_SECRET || "";

const MAX_SESSIONS = 10;
// Current token plus the previous ones still accepted, so concurrent or interrupted refreshes survive.
const TOKENS_KEPT_PER_SESSION = 3;

type UserDoc = InstanceType<typeof UserModel>;

export interface RefreshPayload {
	UserInfo: { email: string; roles: unknown; sessionId: string };
}

const signTokens = (user: UserDoc, sessionId: string) => {
	const payload = { UserInfo: { email: user.email, roles: user.roles, sessionId } };
	return {
		accessToken: jwt.sign(payload, accessTokenKey, { expiresIn: "10 minutes" }),
		refreshToken: jwt.sign(payload, refreshTokenKey, { expiresIn: "30d" }),
	};
};

// User document as JSON without credentials or other devices' tokens.
export const toPublicUser = (user: UserDoc) => {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { password, refreshToken, sessions, sessionId, resetPasswordTokens, emailVerificationTokens, ...rest } =
		user.toObject();
	return rest;
};

export const isSessionActive = (user: UserDoc, sessionId: string) =>
	user.sessionId === sessionId || user.sessions.some((session) => session.sessionId === sessionId);

/** Starts a new device session alongside existing ones; the least recently used are dropped beyond the cap. */
export const createSession = async (user: UserDoc) => {
	const sessionId = new mongoose.Types.ObjectId().toString();
	const tokens = signTokens(user, sessionId);
	user.sessions = [
		{ sessionId, refreshTokens: [tokens.refreshToken], lastUsedAt: new Date() },
		...[...user.sessions].sort((a, b) => +new Date(b.lastUsedAt) - +new Date(a.lastUsedAt)),
	].slice(0, MAX_SESSIONS);
	await user.save();
	return tokens;
};

export type RefreshResult =
	| { ok: true; user: UserDoc; accessToken: string; refreshToken: string }
	| { ok: false; status: 401 | 403; message: string };

/**
 * Rotates a refresh token within its own session. A token older than the kept window is treated as reuse and
 * revokes only that session, never the user's other devices.
 */
export const refreshSession = async (presentedToken: string): Promise<RefreshResult> => {
	let decoded: RefreshPayload;
	try {
		decoded = jwt.verify(presentedToken, refreshTokenKey) as RefreshPayload;
	} catch {
		return { ok: false, status: 403, message: "Refresh token is invalid or expired." };
	}
	const { email, sessionId } = decoded?.UserInfo ?? {};
	if (!email || !sessionId) return { ok: false, status: 403, message: "Refresh token is malformed." };

	const user = await UserModel.findOne({ email }).exec();
	if (!user) return { ok: false, status: 403, message: "User not found." };

	let session = user.sessions.find((s) => s.sessionId === sessionId);
	// Migrate a pre-multi-session login the first time it refreshes.
	if (!session && user.sessionId === sessionId && user.refreshToken.includes(presentedToken)) {
		user.sessions.push({ sessionId, refreshTokens: [presentedToken], lastUsedAt: new Date() });
		user.sessionId = "";
		user.refreshToken = [];
		await user.save();
		session = user.sessions.find((s) => s.sessionId === sessionId);
	}
	if (!session) return { ok: false, status: 403, message: "Session has ended. Please sign in again." };

	if (!session.refreshTokens.includes(presentedToken)) {
		await UserModel.updateOne({ _id: user._id }, { $pull: { sessions: { sessionId } } }).exec();
		return { ok: false, status: 403, message: "Session has ended. Please sign in again." };
	}

	// Atomic push, so two refreshes racing on the same session both keep their new token.
	const tokens = signTokens(user, sessionId);
	await UserModel.updateOne(
		{ _id: user._id, "sessions.sessionId": sessionId },
		{
			$push: {
				"sessions.$.refreshTokens": {
					$each: [tokens.refreshToken],
					$position: 0,
					$slice: TOKENS_KEPT_PER_SESSION,
				},
			},
			$set: { "sessions.$.lastUsedAt": new Date() },
		},
	).exec();
	return { ok: true, user, ...tokens };
};

/** Ends only the session the token belongs to. */
export const endSession = async (presentedToken: string) => {
	const decoded = jwt.decode(presentedToken) as RefreshPayload | null;
	const sessionId = decoded?.UserInfo?.sessionId;
	const user = sessionId
		? await UserModel.findOne({ $or: [{ "sessions.sessionId": sessionId }, { refreshToken: presentedToken }] })
		: await UserModel.findOne({ refreshToken: presentedToken });
	if (!user) return;
	user.sessions = user.sessions.filter((s) => s.sessionId !== sessionId);
	if (user.refreshToken.includes(presentedToken)) {
		user.refreshToken = [];
		user.sessionId = "";
	}
	await user.save();
};
