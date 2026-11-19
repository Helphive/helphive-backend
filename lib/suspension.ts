// Account suspension for customers and providers (set by an admin). Pure helpers; the checks live where each kind of
// access is decided: sign-in (auth.controller), refresh (session.utils), every API call and the provider socket
// (token.utils verifyAccessToken, provider-websocket stillAuthorized).
import type mongoose from "mongoose";

/**
 * Sign-in answer for a suspended account, given only after the password matched (so it reveals nothing to someone
 * guessing). 423 because both apps already treat 401 and 403 at sign-in as "wrong password" and "verify your email":
 * the web app shows this message as written; the installed mobile app shows its generic "unexpected error" text.
 */
export const SUSPENDED_SIGN_IN = {
	status: 423,
	body: {
		message: "This account is suspended. Contact HelpHive support to restore it.",
		code: "account_suspended",
	},
} as const;

export const isSuspended = (user: { suspended?: boolean | null } | null | undefined) => !!user?.suspended;

/**
 * The single update that suspends an account: the flag, who and why (admin-only fields), provider availability off,
 * and every session ended (the same fields endAllSessions clears). Applied atomically with { suspended: { $ne: true } }.
 */
export const suspendUpdate = (adminId: mongoose.Types.ObjectId | string, reason: string, now: Date) => ({
	$set: {
		suspended: true,
		suspendedAt: now,
		suspendedBy: adminId,
		suspendedReason: reason,
		isProviderAvailable: false,
		sessions: [],
		refreshToken: [],
		sessionId: "",
	},
});

/** Lifts the suspension. Sessions stay ended and availability stays off; the person signs in again. */
export const reinstateUpdate = () => ({
	$set: { suspended: false },
	$unset: { suspendedAt: 1, suspendedBy: 1, suspendedReason: 1 },
});
