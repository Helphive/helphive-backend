import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket as WS } from "ws";
import UserModel from "../../dal/models/user.model";
import { verifyAccessToken } from "./utils/token.utils";
import { isSessionActive } from "./utils/session.utils";
import {
	attachProviderSocket,
	AvailabilityUpdate,
	MAX_MESSAGE_BYTES,
	ProviderCheck,
	WS_CLOSE,
} from "./provider-websocket-auth";
import {
	FixedWindowCounter,
	RATE_LIMITS,
	RATE_LIMIT_MESSAGE,
	clientIpFrom,
	ipKey,
} from "../../middleware/rateLimitKeys";
import { emitEvent } from "../../lib/events";
import { isSuspended } from "../../lib/suspension";
import { sendProviderOnlineNotification } from "./utils/provider.utils";
import log from "../../lib/logger";

export const PROVIDER_AVAILABILITY_PATH = "/provider-availability";

// Latest socket per provider. A reconnect opens a new socket before the old one's close event fires, so only the
// latest socket may mark the provider offline.
const activeSockets = new Map<string, WS>();

const isApprovedProvider = (user: InstanceType<typeof UserModel>) =>
	!!user.roles?.Provider && user.providerStatus === "approved";

const authenticate = async (token: string): Promise<ProviderCheck> => {
	const result = await verifyAccessToken(token);
	if (!result.ok || !isApprovedProvider(result.user)) return { ok: false };
	return { ok: true, email: result.email, sessionId: result.sessionId };
};

const stillAuthorized = async (email: string, sessionId: string) => {
	const user = await UserModel.findOne({ email }).exec();
	return !!user && !isSuspended(user) && isSessionActive(user, sessionId) && isApprovedProvider(user);
};

/**
 * Closes this instance's open socket for a provider (suspension). Sockets on other instances are refused at their
 * next message, since every message checks stillAuthorized first. Returns whether a socket was closed here.
 */
export const closeProviderSocket = (email: string) => {
	const ws = activeSockets.get(email);
	if (!ws) return false;
	try {
		ws.send(JSON.stringify({ type: "error", code: WS_CLOSE.UNAUTHORIZED, message: "Session has ended." }));
		ws.close(WS_CLOSE.UNAUTHORIZED, "Session has ended.");
	} catch {
		// Already closing.
	}
	return true;
};

/** Records a change of availability (not location-only updates, which arrive every few seconds). */
const recordAvailabilityChange = (
	providerId: unknown,
	available: boolean,
	via: "websocket" | "disconnect",
	jobTypes?: number[],
	closeCode?: number | null,
) =>
	emitEvent({
		type: "provider.availability_changed",
		actor: {
			type: via === "disconnect" ? "system" : "provider",
			id: via === "disconnect" ? undefined : String(providerId),
		},
		subjects: { providerId: String(providerId) },
		properties: {
			available,
			via,
			...(jobTypes ? { jobTypes } : {}),
			...(closeCode !== undefined ? { closeCode } : {}),
		},
	});

const saveAvailability = async (email: string, update: AvailabilityUpdate) => {
	const set: Record<string, unknown> = { isProviderAvailable: update.isProviderAvailable };
	if (update.currentLocation) {
		set.currentLocation = update.currentLocation;
		set.locationUpdatedAt = new Date();
	}
	if (update.selectedJobs) set.selectedJobTypes = update.selectedJobs.map((id) => ({ id }));
	// Same update as before; the previous value tells whether availability actually changed.
	const previous = await UserModel.findOneAndUpdate(
		{ email },
		{ $set: set },
		{ runValidators: true, new: false, projection: { _id: 1, isProviderAvailable: 1 } },
	).exec();
	if (previous && previous.isProviderAvailable !== update.isProviderAvailable) {
		recordAvailabilityChange(previous._id, update.isProviderAvailable, "websocket", update.selectedJobs);
		if (update.isProviderAvailable) void sendProviderOnlineNotification(String(previous._id));
	}
};

/** The provider ended the socket on purpose (switched off, signed out) or the session is over: no longer available. */
const markOffline = async (email: string, closeCode: number | null) => {
	try {
		const previous = await UserModel.findOneAndUpdate(
			{ email },
			{ $set: { isProviderAvailable: false } },
			{ new: false, projection: { _id: 1, isProviderAvailable: 1 } },
		).exec();
		if (previous?.isProviderAvailable) {
			recordAvailabilityChange(previous._id, false, "disconnect", undefined, closeCode);
		}
	} catch (error) {
		log.error("Error updating provider availability on disconnect", error);
	}
};

export const handleProviderAvailabilityWebSocket = (ws: WS) => {
	attachProviderSocket(ws, {
		authenticate,
		stillAuthorized,
		saveAvailability,
		onAuthenticated: (email) => activeSockets.set(email, ws),
		onAuthenticatedClose: (email, end) => {
			if (activeSockets.get(email) !== ws) return;
			activeSockets.delete(email);
			// A lost connection (app in the background, no signal, app killed, this instance replaced) keeps the
			// provider available: job alerts reach them as push notifications. Only a deliberate end switches them off.
			if (end.offline) void markOffline(email, end.code);
			else log.info("Provider availability socket lost; the provider stays available", { closeCode: end.code });
		},
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
		log: (message, error) => log.error(message, error),
	});
};

const rejectUpgrade = (
	socket: Duplex,
	status: number,
	text: string,
	message: string,
	headers: Record<string, string> = {},
) => {
	const lines = [`HTTP/1.1 ${status} ${text}`, "Connection: close", "Content-Type: application/json"];
	for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
	const body = JSON.stringify({ message });
	lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
	socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`);
};

/** Accepts websocket upgrades on the provider availability path only, limited per client IP. */
export const createProviderAvailabilityUpgradeHandler = (trustProxyHops: number) => {
	const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
	const connections = new FixedWindowCounter(RATE_LIMITS.wsConnectionsPerIp);
	wsServer.on("connection", (ws: WS) => handleProviderAvailabilityWebSocket(ws));

	return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		socket.on("error", () => socket.destroy());
		let pathname = "";
		try {
			pathname = new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/, "");
		} catch {
			pathname = "";
		}
		if (pathname !== PROVIDER_AVAILABILITY_PATH) return rejectUpgrade(socket, 404, "Not Found", "Not found.");

		const ip = clientIpFrom(req.socket.remoteAddress, req.headers["x-forwarded-for"], trustProxyHops);
		const attempt = connections.hit(ipKey(ip));
		if (!attempt.allowed) {
			return rejectUpgrade(socket, 429, "Too Many Requests", RATE_LIMIT_MESSAGE, {
				"Retry-After": String(attempt.retryAfter),
			});
		}
		wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req));
	};
};
