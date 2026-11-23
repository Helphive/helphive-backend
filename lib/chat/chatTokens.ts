// CometChat auth tokens for app sessions. A token is created per sign-in session (POST /auth/chat/session), stored
// encrypted on that session, and revoked when the session ends: sign-out, the session cap dropping it, password
// reset, "end all sessions", suspension. Revocation never delays or fails the caller; failures are logged.
import { keyFromConfig, open, seal, subKey } from "../secretBox";
import { cometChat, ChatNotConfiguredError } from "./cometchat";
import log from "../logger";

/**
 * Key for chat tokens at rest: CHAT_TOKEN_ENCRYPTION_KEY, else derived from ACCESS_TOKEN_SECRET. If it changes, stored
 * tokens cannot be read; the next chat-session call then simply issues a new one.
 */
const tokenKey = () => {
	const configured = process.env.CHAT_TOKEN_ENCRYPTION_KEY?.trim();
	const master = configured
		? keyFromConfig(configured, "helphive-chat-tokens")
		: keyFromConfig(`chat-fallback:${process.env.ACCESS_TOKEN_SECRET ?? ""}`, "helphive-chat-tokens");
	return subKey(master, "chat-auth-token");
};

export const sealChatToken = (token: string) => seal(token, tokenKey());

/** The token, or null when it cannot be read (key changed, corrupted). */
export const openChatToken = (sealed: string | undefined | null): string | null => {
	if (!sealed) return null;
	try {
		return open(sealed, tokenKey());
	} catch {
		return null;
	}
};

const quiet = (what: string) => (error: unknown) => {
	if (error instanceof ChatNotConfiguredError) return;
	log.warn("chat_token_failed", `Could not ${what}`, { error: error instanceof Error ? error.message : "unknown" });
};

/** Revokes one session's token. Fire and forget. */
export const revokeChatToken = (uid: string, sealed: string | undefined | null) => {
	const token = openChatToken(sealed);
	if (!token || !cometChat.configured) return;
	cometChat.deleteAuthToken(uid, token).catch(quiet("revoke a chat token"));
};

/** Revokes every token of the user (all sessions). Fire and forget unless awaited. */
export const revokeAllChatTokens = (uid: string): Promise<void> => {
	if (!cometChat.configured) return Promise.resolve();
	return cometChat.flushAuthTokens(uid).then(() => undefined, quiet("revoke chat tokens"));
};
