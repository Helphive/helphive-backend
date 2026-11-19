// Push registration for app sessions (routes/user-routes/push.route.ts; contract in scratch/chat/chat-contract.md).
// Each session gets its own random OneSignal external id; the app signs in to OneSignal with it. Only active sessions
// are ever targeted (lib/push.ts), so a session that ends here stops getting notifications at once.
import { Request, Response } from "express";
import UserModel from "../../dal/models/user.model";
import { PUSH_ALIAS, PUSH_OFF, newPushAlias } from "../../lib/push";
import { forgetPushAliases } from "../service-accounts/onesignal";
import log from "../../lib/logger";

/**
 * POST /auth/push/register: this session's OneSignal external id (the same one on repeat calls). The app then calls
 * OneSignal.login(externalId). 409 for a session the server cannot find (sign in again).
 */
export const handleRegisterPush = async (req: Request, res: Response) => {
	try {
		const user = await UserModel.findOne({ email: req.user }).select("_id sessions.sessionId sessions.pushAlias");
		if (!user) return res.status(404).json({ message: "User not found." });
		const session = user.sessions.find((s) => s.sessionId === req.sessionId);
		if (!session) {
			return res.status(409).json({
				message: "This sign-in is too old for notifications. Sign in again.",
				code: "push_session_unknown",
			});
		}
		let externalId = session.pushAlias;
		if (!externalId || !PUSH_ALIAS.test(externalId)) {
			externalId = newPushAlias();
			await UserModel.updateOne(
				{ _id: user._id, "sessions.sessionId": req.sessionId },
				{ $set: { "sessions.$.pushAlias": externalId } },
			).exec();
		}
		res.json({ provider: "onesignal", externalId });
	} catch (error) {
		log.error("Error registering for push", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};

/** DELETE /auth/push/register: this device stops getting notifications for the account (session stays signed in). */
export const handleUnregisterPush = async (req: Request, res: Response) => {
	try {
		const user = await UserModel.findOne({ email: req.user }).select("_id sessions.sessionId sessions.pushAlias");
		if (!user) return res.sendStatus(204);
		const session = user.sessions.find((s) => s.sessionId === req.sessionId);
		if (session) {
			// Marked off rather than removed, so this session is never treated as an older app (user-id alias).
			await UserModel.updateOne(
				{ _id: user._id, "sessions.sessionId": req.sessionId },
				{ $set: { "sessions.$.pushAlias": PUSH_OFF } },
			).exec();
			if (session.pushAlias && PUSH_ALIAS.test(session.pushAlias)) forgetPushAliases([session.pushAlias]);
		}
		res.sendStatus(204);
	} catch (error) {
		log.error("Error unregistering push", error);
		res.status(500).json({ message: "An error occurred while processing request." });
	}
};
