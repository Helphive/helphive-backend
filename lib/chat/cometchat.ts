// CometChat REST API v3 (server side only; the REST API key never leaves this server). Each call has a timeout and
// throws CometChatError; callers decide whether a failure matters. The transport is injectable for tests.
// Docs: https://www.cometchat.com/docs/rest-api/chat-apis
import axios from "axios";
import { chatConfig, type ChatConfig } from "../../config/chat";

export class CometChatError extends Error {
	constructor(
		readonly status: number,
		/** CometChat's error code (ERR_UID_NOT_FOUND, ...) or a network code. */
		readonly code: string,
	) {
		super(`CometChat request failed (${status} ${code})`);
	}
}

export class ChatNotConfiguredError extends Error {
	constructor() {
		super("Chat is not configured.");
	}
}

export interface ChatRequest {
	method: "GET" | "POST" | "PUT" | "DELETE";
	path: string;
	query?: Record<string, string | number | boolean>;
	body?: unknown;
	/** The user the call acts as (CometChat's onBehalfOf header). */
	onBehalfOf?: string;
}

export type ChatTransport = (
	request: ChatRequest & { baseUrl: string; apiKey: string },
) => Promise<{ status: number; data: any }>;

const TIMEOUT_MS = 5000;

export const axiosChatTransport: ChatTransport = async (request) => {
	try {
		const response = await axios.request({
			method: request.method,
			url: `${request.baseUrl}${request.path}`,
			params: request.query,
			data: request.body,
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				apikey: request.apiKey,
				...(request.onBehalfOf ? { onBehalfOf: request.onBehalfOf } : {}),
			},
			timeout: TIMEOUT_MS,
			validateStatus: () => true,
			maxContentLength: 2_000_000,
		});
		return { status: response.status, data: response.data };
	} catch (error: any) {
		throw new CometChatError(0, error?.code ?? "network");
	}
};

const errorCode = (data: any) =>
	typeof data?.error?.code === "string" ? data.error.code : typeof data?.code === "string" ? data.code : "unknown";

const enc = encodeURIComponent;

export interface ChatMessage {
	id: string;
	sender: string;
	receiver: string;
	receiverType: string;
	category: string;
	type: string;
	text: string | null;
	attachments: { mimeType: string | null; size: number | null; extension: string | null }[];
	sentAt: number | null;
	deletedAt: number | null;
}

/** A CometChat message reduced to what this server uses (no URLs to attachments, no metadata). */
export const toChatMessage = (raw: any): ChatMessage | null => {
	if (!raw || (typeof raw.id !== "string" && typeof raw.id !== "number")) return null;
	const data = raw.data ?? {};
	const attachments = [
		...(Array.isArray(data.attachments) ? data.attachments : []),
		...(data.attachment && !Array.isArray(data.attachments) ? [data.attachment] : []),
	].map((a: any) => ({
		mimeType: typeof a?.mimeType === "string" ? a.mimeType.toLowerCase() : null,
		size: typeof a?.size === "number" ? a.size : Number.isFinite(Number(a?.size)) ? Number(a.size) : null,
		extension: typeof a?.extension === "string" ? a.extension.toLowerCase() : null,
	}));
	return {
		id: String(raw.id),
		sender: String(raw.sender ?? data.entities?.sender?.entity?.uid ?? ""),
		receiver: String(raw.receiver ?? data.entities?.receiver?.entity?.uid ?? ""),
		receiverType: String(raw.receiverType ?? ""),
		category: String(raw.category ?? ""),
		type: String(raw.type ?? ""),
		text: typeof data.text === "string" ? data.text : null,
		attachments,
		sentAt: typeof raw.sentAt === "number" ? raw.sentAt : null,
		deletedAt: typeof raw.deletedAt === "number" ? raw.deletedAt : null,
	};
};

export const createCometChatClient = (options: { config?: () => ChatConfig; transport?: ChatTransport } = {}) => {
	const config = options.config ?? (() => chatConfig());
	const transport = options.transport ?? axiosChatTransport;

	const call = async (request: ChatRequest, okCodes: string[] = []) => {
		const current = config();
		if (!current.configured) throw new ChatNotConfiguredError();
		const { status, data } = await transport({ ...request, baseUrl: current.baseUrl, apiKey: current.restApiKey });
		if (status >= 200 && status < 300) return data?.data ?? data;
		const code = errorCode(data);
		if (okCodes.includes(code)) return null;
		throw new CometChatError(status, code);
	};

	return {
		get configured() {
			return config().configured;
		},

		/** Creates the user; an existing uid is not an error. */
		createUser: (user: { uid: string; name: string; avatar?: string; role?: string; email?: string }) =>
			call(
				{
					method: "POST",
					path: "/users",
					body: {
						uid: user.uid,
						name: user.name,
						...(user.avatar ? { avatar: user.avatar } : {}),
						...(user.role ? { role: user.role } : {}),
						...(user.email ? { metadata: { "@private": { email: user.email } } } : {}),
					},
				},
				["ERR_UID_ALREADY_EXISTS"],
			),

		updateUser: (uid: string, fields: { name?: string; avatar?: string; role?: string }) =>
			call({ method: "PUT", path: `/users/${enc(uid)}`, body: fields }),

		/** A new auth token for one sign-in session (force: a fresh token, not a reused one). */
		createAuthToken: async (uid: string): Promise<string> => {
			const data = await call({ method: "POST", path: `/users/${enc(uid)}/auth_tokens`, body: { force: true } });
			if (typeof data?.authToken !== "string") throw new CometChatError(502, "no_token");
			return data.authToken;
		},

		deleteAuthToken: (uid: string, authToken: string) =>
			call({ method: "DELETE", path: `/users/${enc(uid)}/auth_tokens/${enc(authToken)}` }, [
				"ERR_AUTH_TOKEN_NOT_FOUND",
				"ERR_UID_NOT_FOUND",
			]),

		/** Revokes every auth token of the user (sign out everywhere, suspension). */
		flushAuthTokens: (uid: string) =>
			call({ method: "DELETE", path: `/users/${enc(uid)}/auth_tokens` }, ["ERR_UID_NOT_FOUND"]),

		/** Friendship is mutual in CometChat; one call creates it for both users. */
		addFriend: (uid: string, friendUid: string) =>
			call({ method: "POST", path: `/users/${enc(uid)}/friends`, body: { accepted: [friendUid] } }),

		removeFriend: (uid: string, friendUid: string) =>
			call({ method: "DELETE", path: `/users/${enc(uid)}/friends`, body: { friends: [friendUid] } }, [
				"ERR_UID_NOT_FOUND",
			]),

		listFriends: async (uid: string): Promise<string[]> => {
			const data = await call({ method: "GET", path: `/users/${enc(uid)}/friends`, query: { perPage: 1000 } }, [
				"ERR_UID_NOT_FOUND",
			]);
			return (Array.isArray(data) ? data : [])
				.map((friend: any) => friend?.uid)
				.filter((id: unknown): id is string => typeof id === "string");
		},

		blockUser: (uid: string, blockedUid: string) =>
			call({ method: "POST", path: `/users/${enc(uid)}/blockedusers`, body: { blockedUids: [blockedUid] } }),

		unblockUser: (uid: string, blockedUid: string) =>
			call({ method: "DELETE", path: `/users/${enc(uid)}/blockedusers`, body: { blockedUids: [blockedUid] } }),

		/** Unread messages across the user's conversations (one page of up to 100 unread conversations). */
		unreadCount: async (uid: string): Promise<{ unreadCount: number; conversations: number }> => {
			const data = await call({
				method: "GET",
				path: "/conversations",
				query: { unread: true, perPage: 100 },
				onBehalfOf: uid,
			});
			const list = Array.isArray(data) ? data : [];
			const unreadCount = list.reduce((sum: number, conversation: any) => {
				const count = Number(conversation?.unreadMessageCount ?? 0);
				return sum + (Number.isFinite(count) && count > 0 ? count : 0);
			}, 0);
			return { unreadCount, conversations: list.filter((c: any) => Number(c?.unreadMessageCount) > 0).length };
		},

		getMessage: async (id: string, onBehalfOf?: string) =>
			toChatMessage(await call({ method: "GET", path: `/messages/${enc(id)}`, onBehalfOf })),

		/** The latest messages between `uid` and `withUid`, oldest first. */
		listConversationMessages: async (uid: string, withUid: string, limit = 50): Promise<ChatMessage[]> => {
			const data = await call({
				method: "GET",
				path: `/users/${enc(withUid)}/messages`,
				query: { perPage: Math.min(Math.max(limit, 1), 100) },
				onBehalfOf: uid,
			});
			return (Array.isArray(data) ? data : [])
				.map(toChatMessage)
				.filter((m): m is ChatMessage => !!m)
				.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
		},

		deleteMessage: (id: string, onBehalfOf?: string) =>
			call({ method: "DELETE", path: `/messages/${enc(id)}`, body: { permanent: false }, onBehalfOf }, [
				"ERR_MESSAGE_NOT_FOUND",
			]),

		sendText: (fromUid: string, toUid: string, text: string) =>
			call({
				method: "POST",
				path: "/messages",
				body: { category: "message", type: "text", data: { text }, receiver: toUid, receiverType: "user" },
				onBehalfOf: fromUid,
			}),
	};
};

export type CometChatClient = ReturnType<typeof createCometChatClient>;

export const cometChat = createCometChatClient();
