import crypto from "crypto";
import jwt from "jsonwebtoken";
import UserModel from "../../../dal/models/user.model";
import { isSessionActive } from "./session.utils";
import { isSuspended } from "../../../lib/suspension";
import { findUserByEmail } from "./accountEmail.utils";

export const JWT_ALGORITHMS: jwt.Algorithm[] = ["HS256"];

const accessTokenKey = () => process.env.ACCESS_TOKEN_SECRET || "";

type UserDoc = InstanceType<typeof UserModel>;

export type AccessTokenResult =
	| { ok: true; user: UserDoc; email: string; sessionId: string }
	| { ok: false; reason: "invalid" | "inactive" };

/**
 * The single check behind every user-authenticated request and the provider websocket: a valid HS256 access token
 * whose session is still active on a user who is not suspended. Database errors propagate to the caller.
 */
export const verifyAccessToken = async (token: unknown): Promise<AccessTokenResult> => {
	if (typeof token !== "string" || !token || token.length > 4096) return { ok: false, reason: "invalid" };
	let decoded: any;
	try {
		decoded = jwt.verify(token, accessTokenKey(), { algorithms: JWT_ALGORITHMS });
	} catch {
		return { ok: false, reason: "invalid" };
	}
	const email = decoded?.UserInfo?.email;
	const sessionId = decoded?.UserInfo?.sessionId;
	if (typeof email !== "string" || typeof sessionId !== "string" || !email || !sessionId) {
		return { ok: false, reason: "invalid" };
	}
	// Any letter case, so a token issued before the stored email was lower-cased still works.
	const user = await findUserByEmail(email);
	// A suspended account is refused even if a session survived (a sign-in racing the suspension re-saving sessions).
	if (!user || isSuspended(user) || !isSessionActive(user, sessionId)) return { ok: false, reason: "inactive" };
	return { ok: true, user, email: user.email, sessionId };
};

/** Email links store only a hash of their token, so a database reader cannot use a pending link. */
export const hashEmailToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const MAX_PENDING_EMAIL_TOKENS = 5;

/** The stored list with this token's hash added and only the newest few kept. */
export const addEmailToken = (stored: string[], token: string) =>
	[...stored, hashEmailToken(token)].slice(-MAX_PENDING_EMAIL_TOKENS);

/** Whether a presented token is pending: stored as a hash, or raw for links sent before hashing. */
export const isPendingEmailToken = (stored: string[], token: string) =>
	stored.includes(hashEmailToken(token)) || stored.includes(token);

/** Constant-time string comparison for shared secrets. */
export const safeEqual = (a: string, b: string) => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
};
