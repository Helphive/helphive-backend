// Who a push notification reaches, decided on the server from the person's active sessions at send time, so a device
// stops getting an account's notifications as soon as its session ends here (sign-out, "end all sessions", suspension,
// an admin ending sessions, the session cap), even if the device was offline when the person signed out.
//
// Each app session registers its own random OneSignal external id (POST /auth/push/register; the app then calls
// OneSignal.login(externalId)). Only sessions that are still active are targeted. Older app builds identify the device
// with the user id instead; that alias is targeted only while the person has an active session that has not
// registered (PUSH_LEGACY_EXTERNAL_ID=false turns it off), and is deleted in OneSignal when the person has no session
// left. Pure functions here; the OneSignal calls are in controllers/service-accounts/onesignal.ts.
import crypto from "crypto";

/** OneSignal external ids this server issues: "hhp_" and 32 hex characters (unguessable, unlike a user id). */
export const PUSH_ALIAS = /^hhp_[a-f0-9]{32}$/;

export const newPushAlias = () => `hhp_${crypto.randomBytes(16).toString("hex")}`;

/** Stored instead of an alias when a session turned notifications off: registered, but never targeted. */
export const PUSH_OFF = "off";

/** A session that has not refreshed for longer than its refresh token lives cannot come back; it gets nothing. */
export const SESSION_PUSH_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PushSession {
	sessionId?: string;
	pushAlias?: string | null;
	lastUsedAt?: Date | string | null;
}

export interface PushUser {
	_id: { toString(): string };
	sessions?: PushSession[] | null;
	/** Pre-multi-session login still in place (one legacy session). */
	sessionId?: string | null;
	suspended?: boolean | null;
}

export const legacyPushEnabled = (env: NodeJS.ProcessEnv = process.env) =>
	env.PUSH_LEGACY_EXTERNAL_ID?.trim().toLowerCase() !== "false";

/**
 * The OneSignal external ids to target for these users: the push alias of every active session, plus the user id
 * (older apps) when an active session has none. A suspended person, or one with no active session, gets nothing.
 */
export const pushTargets = (users: PushUser[], now = new Date(), legacy = legacyPushEnabled()): string[] => {
	const targets = new Set<string>();
	for (const user of users) {
		if (user.suspended) continue;
		const active = (user.sessions ?? []).filter(
			(s) => !s.lastUsedAt || now.getTime() - new Date(s.lastUsedAt).getTime() <= SESSION_PUSH_MAX_IDLE_MS,
		);
		let unregistered = !!user.sessionId;
		for (const session of active) {
			if (session.pushAlias === PUSH_OFF) continue;
			if (session.pushAlias && PUSH_ALIAS.test(session.pushAlias)) targets.add(session.pushAlias);
			else unregistered = true;
		}
		if (legacy && unregistered) targets.add(String(user._id));
	}
	return [...targets];
};

/** The external ids to delete in OneSignal when these sessions end (and the user id when none is left). */
export const aliasesToForget = (
	userId: string,
	ended: PushSession[],
	remaining: PushSession[],
	legacySessionLeft = false,
): string[] => {
	const aliases = ended.map((s) => s.pushAlias).filter((a): a is string => !!a && PUSH_ALIAS.test(a));
	const anyUnregisteredLeft = legacySessionLeft || remaining.some((s) => !s.pushAlias);
	if (!anyUnregisteredLeft) aliases.push(userId);
	return [...new Set(aliases)];
};

/** Short preview of a chat message for a push: at most `max` characters, single line. */
export const chatPreview = (text: string | null, type: string, max = 60): string => {
	if (!text) {
		if (type === "image") return "sent a photo";
		if (type === "video") return "sent a video";
		if (type === "audio") return "sent a voice message";
		if (type === "file") return "sent a file";
		return "sent you a message";
	}
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return "sent you a message";
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The push for a new chat message. With previews off, no message text at all. */
export const chatPushContent = (input: {
	senderFirstName: string | null | undefined;
	senderUid: string;
	text: string | null;
	type: string;
	preview: boolean;
	webAppUrl: string;
}) => {
	const name = (input.senderFirstName ?? "").trim() || "Someone";
	const body = input.preview ? chatPreview(input.text, input.type) : "sent you a message";
	const group = `chat-${input.senderUid}`;
	return {
		headings: { en: name },
		contents: { en: input.preview && input.text ? body : `${name} ${body}` },
		// One notification per conversation on the device: a burst replaces itself instead of stacking.
		collapse_id: group,
		android_group: group,
		thread_id: group,
		data: {
			screen: "Chat",
			type: "chat_message",
			senderUid: input.senderUid,
			// The renamed app opens this (lib/appIdentity.ts link rules); older apps ignore unknown screens and just open.
			deepLink: `helphive://chat/${input.senderUid}`,
			webUrl: `${input.webAppUrl}/chat/${input.senderUid}`,
		},
	};
};
