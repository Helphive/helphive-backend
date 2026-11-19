// Admin refresh tokens: opaque, rotated on every use, one session ("family") per sign-in.
//
// Token: "<sessionId>.<generation>.<random>.<tag>". The tag is an HMAC of the first three parts with a server key,
// so the server can tell a genuine old token (reuse: revoke the whole session) from a made-up one (ignore it) without
// keeping every token it ever issued. Only a SHA-256 hash of the current token, and of the one before it, is stored.
//
// Two tabs share the cookie, so both may refresh with the same token at once. The loser presents the previous token
// moments after rotation; within REFRESH_REUSE_GRACE_MS that is treated as the race it is (it gets an access token
// and no new cookie) rather than as theft.
import crypto from "crypto";

export const REFRESH_REUSE_GRACE_MS = 30 * 1000;

export interface ParsedRefreshToken {
	sessionId: string;
	generation: number;
	token: string;
}

const tagFor = (key: Buffer, body: string) =>
	crypto.createHmac("sha256", key).update(body).digest("base64url").slice(0, 32);

export const hashRefreshToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export const issueRefreshToken = (key: Buffer, sessionId: string, generation: number) => {
	const body = `${sessionId}.${generation}.${crypto.randomBytes(32).toString("base64url")}`;
	const token = `${body}.${tagFor(key, body)}`;
	return { token, hash: hashRefreshToken(token) };
};

/** Session and generation of a token carrying our tag, or null for anything else (never throws). */
export const parseRefreshToken = (key: Buffer, token: unknown): ParsedRefreshToken | null => {
	if (typeof token !== "string" || token.length > 256) return null;
	const parts = token.split(".");
	if (parts.length !== 4) return null;
	const [sessionId, generationText, random, tag] = parts;
	if (!/^[a-f\d]{24}$/i.test(sessionId) || !/^\d{1,9}$/.test(generationText) || !/^[\w-]{43}$/.test(random)) {
		return null;
	}
	const expected = Buffer.from(tagFor(key, `${sessionId}.${generationText}.${random}`));
	const presented = Buffer.from(tag);
	if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) return null;
	return { sessionId, generation: Number(generationText), token };
};

export interface RefreshSessionState {
	generation: number;
	tokenHash: string;
	previousTokenHash?: string | null;
	rotatedAt?: Date | null;
	revokedAt?: Date | null;
	expiresAt: Date;
	lastUsedAt: Date;
}

export type RefreshDecision =
	| { kind: "rotate" }
	| { kind: "grace" }
	| { kind: "reuse" }
	| { kind: "revoked" }
	| { kind: "expired"; reason: "absolute" | "idle" }
	| { kind: "invalid" };

/**
 * What to do with a presented (tag-verified) token against its stored session:
 * - rotate: the current token; issue the next one.
 * - grace: the previous token within the grace period after rotation (two tabs racing); access token only.
 * - reuse: any other older token of this session; somebody kept a copy, so the whole session is revoked.
 * - revoked / expired / invalid: refuse.
 */
export const decideRefresh = (
	session: RefreshSessionState | null,
	parsed: ParsedRefreshToken,
	now: Date,
	idleTimeoutMs: number,
): RefreshDecision => {
	if (!session) return { kind: "invalid" };
	if (session.revokedAt) return { kind: "revoked" };
	if (session.expiresAt.getTime() <= now.getTime()) return { kind: "expired", reason: "absolute" };
	const presentedHash = hashRefreshToken(parsed.token);
	if (parsed.generation === session.generation) {
		if (!safeHexEqual(presentedHash, session.tokenHash)) return { kind: "invalid" };
		if (now.getTime() - session.lastUsedAt.getTime() > idleTimeoutMs) return { kind: "expired", reason: "idle" };
		return { kind: "rotate" };
	}
	if (parsed.generation > session.generation) return { kind: "invalid" };
	if (
		parsed.generation === session.generation - 1 &&
		session.previousTokenHash &&
		safeHexEqual(presentedHash, session.previousTokenHash) &&
		session.rotatedAt &&
		now.getTime() - session.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS
	) {
		return { kind: "grace" };
	}
	return { kind: "reuse" };
};

const safeHexEqual = (a: string, b: string) => {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
};
