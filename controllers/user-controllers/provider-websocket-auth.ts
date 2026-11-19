// Protocol and per-socket state machine for /provider-availability. Kept free of database and ws imports so it can be
// unit tested with a fake socket; provider-websocket.ts supplies the real dependencies.
import { FixedWindowCounter, RATE_LIMITS } from "../../middleware/rateLimitKeys";

export const WS_CLOSE = {
	/** No valid auth message within the deadline, an invalid token, not an approved provider, or the session ended. */
	UNAUTHORIZED: 4401,
	/** Too many messages on this socket. */
	RATE_LIMITED: 4429,
} as const;

export const AUTH_TIMEOUT_MS = 10_000;
export const MAX_MESSAGE_BYTES = 4096;

export interface AvailabilityUpdate {
	isProviderAvailable: boolean;
	currentLocation?: { latitude: number; longitude: number };
	selectedJobs?: number[];
}

export type ClientMessage =
	| { kind: "auth"; token: string }
	| { kind: "availability"; update: AvailabilityUpdate }
	| { kind: "invalid" };

const isLatitude = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
const isLongitude = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;

/** Parses one text frame. Anything that is not a well-formed auth or availability message is "invalid". */
export const parseClientMessage = (raw: string): ClientMessage => {
	if (raw.length > MAX_MESSAGE_BYTES) return { kind: "invalid" };
	let data: any;
	try {
		data = JSON.parse(raw);
	} catch {
		return { kind: "invalid" };
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "invalid" };

	if (data.type === "auth") {
		return typeof data.token === "string" && data.token.length > 0 && data.token.length <= 4096
			? { kind: "auth", token: data.token }
			: { kind: "invalid" };
	}

	if (typeof data.isProviderAvailable !== "boolean") return { kind: "invalid" };
	const update: AvailabilityUpdate = { isProviderAvailable: data.isProviderAvailable };
	const location = data.currentLocation;
	// The app sends { latitude: null, longitude: null } before it has a fix; that keeps the stored location.
	if (location && typeof location === "object" && isLatitude(location.latitude) && isLongitude(location.longitude)) {
		update.currentLocation = { latitude: location.latitude, longitude: location.longitude };
	}
	if (Array.isArray(data.selectedJobs)) {
		const jobs = data.selectedJobs.map(Number);
		if (jobs.length > 3 || !jobs.every((id: number) => id === 1 || id === 2 || id === 3))
			return { kind: "invalid" };
		update.selectedJobs = [...new Set<number>(jobs)];
	}
	return { kind: "availability", update };
};

export interface SocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	on(event: "message", listener: (data: unknown, isBinary?: boolean) => void): unknown;
	on(event: "close", listener: () => void): unknown;
}

export type ProviderCheck = { ok: true; email: string; sessionId: string } | { ok: false };

export interface ProviderSocketDeps {
	/** Verifies an access token exactly like verifyJWT and requires an approved Provider. */
	authenticate(token: string): Promise<ProviderCheck>;
	/** Whether the session behind the socket is still active and the user still an approved provider. */
	stillAuthorized(email: string, sessionId: string): Promise<boolean>;
	saveAvailability(email: string, update: AvailabilityUpdate): Promise<void>;
	/** Called once when the socket closes after authenticating. */
	onAuthenticatedClose(email: string): void;
	onAuthenticated(email: string): void;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	now?: () => number;
	log?: (message: string, error?: unknown) => void;
}

const send = (ws: SocketLike, message: Record<string, unknown>) => {
	try {
		ws.send(JSON.stringify(message));
	} catch {
		// The socket is already closing.
	}
};

/**
 * Drives one socket: the first auth message decides who it acts for. Messages before that are ignored; no valid auth
 * within AUTH_TIMEOUT_MS, or an invalid token, closes it with 4401. Returns a small handle for tests.
 */
export const attachProviderSocket = (ws: SocketLike, deps: ProviderSocketDeps) => {
	const state: { email: string | null; sessionId: string | null; closed: boolean; authenticating: boolean } = {
		email: null,
		sessionId: null,
		closed: false,
		authenticating: false,
	};
	const messages = new FixedWindowCounter(RATE_LIMITS.wsMessagesPerSocket, deps.now);
	const log = deps.log ?? (() => undefined);

	const close = (code: number, reason: string) => {
		if (state.closed) return;
		state.closed = true;
		deps.clearTimer(timer);
		send(ws, { type: "error", code, message: reason });
		ws.close(code, reason);
	};

	const timer = deps.setTimer(() => {
		if (!state.email) close(WS_CLOSE.UNAUTHORIZED, "Authentication required.");
	}, AUTH_TIMEOUT_MS);

	let queue: Promise<void> = Promise.resolve();

	const handle = async (raw: unknown, isBinary?: boolean) => {
		if (state.closed) return;
		if (!messages.hit("socket").allowed) return close(WS_CLOSE.RATE_LIMITED, "Too many messages.");
		const text = isBinary
			? null
			: Buffer.isBuffer(raw)
				? raw.toString("utf8")
				: typeof raw === "string"
					? raw
					: null;
		const message = text === null ? ({ kind: "invalid" } as const) : parseClientMessage(text);

		if (!state.email) {
			// Before authentication only an auth message does anything.
			if (message.kind !== "auth" || state.authenticating) return;
			state.authenticating = true;
			let result: ProviderCheck;
			try {
				result = await deps.authenticate(message.token);
			} catch (error) {
				log("Error authenticating provider socket:", error);
				result = { ok: false };
			}
			state.authenticating = false;
			if (state.closed) return;
			if (!result.ok) return close(WS_CLOSE.UNAUTHORIZED, "Invalid or expired token.");
			state.email = result.email;
			state.sessionId = result.sessionId;
			deps.clearTimer(timer);
			deps.onAuthenticated(result.email);
			send(ws, { type: "auth_ok" });
			return;
		}

		if (message.kind === "auth") return; // Already authenticated; the socket keeps its identity.
		if (message.kind === "invalid") {
			send(ws, { type: "error", error: "Invalid message." });
			return;
		}

		try {
			if (!(await deps.stillAuthorized(state.email, state.sessionId as string))) {
				return close(WS_CLOSE.UNAUTHORIZED, "Session has ended.");
			}
			await deps.saveAvailability(state.email, message.update);
			send(ws, { type: "availability_updated", message: "Provider availability updated." });
		} catch (error) {
			log("Error saving provider availability:", error);
			send(ws, { type: "error", error: "An error occurred while saving user data." });
		}
	};

	// Messages are handled one at a time so an availability update never races the auth that precedes it.
	ws.on("message", (raw, isBinary) => {
		queue = queue.then(() => handle(raw, isBinary));
	});

	ws.on("close", () => {
		state.closed = true;
		deps.clearTimer(timer);
		if (state.email) deps.onAuthenticatedClose(state.email);
	});

	return {
		get email() {
			return state.email;
		},
		get closed() {
			return state.closed;
		},
		/** Resolves once every message received so far has been handled. */
		settled: () => queue,
	};
};
