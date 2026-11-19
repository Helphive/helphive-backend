// Keeps CometChat in line with bookings: a customer and a provider are CometChat friends exactly while they may chat
// (lib/chat/chatRules.ts), and every user's role friends-only messaging (set in the dashboard) makes CometChat itself
// refuse messages between anyone else, whatever a modified client tries.
//
// Called from the booking lifecycle (accept, complete, cancel, admin release), from a Cloud Task when a grace period
// ends, lazily when someone opens chat, and by scripts/reconcile-chat.ts. Never throws to its callers.
import mongoose from "mongoose";
import BookingModel from "../../dal/models/booking.model";
import UserModel from "../../dal/models/user.model";
import { ChatLinkModel } from "../../dal/models/chat.model";
import { CHAT_MEMBER_ROLE, CHAT_SUSPENDED_ROLE, chatConfig } from "../../config/chat";
import { GOOGLE_CLOUD_TASKS_QUEUE_PATH, SERVER_BASE_URL, USER_PROFILES_BUCKET } from "../../config/config";
import { isDemoAccountEmail } from "../../config/demoAccounts";
import { ChatNotConfiguredError, CometChatError, cometChat, type CometChatClient } from "./cometchat";
import { decidePair, type PairState } from "./chatRules";
import { emitEvent } from "../events";
import log from "../logger";

type Id = mongoose.Types.ObjectId | string;

const BOOKING_FIELDS = "status userId providerId acceptedAt completedAt cancelledAt updatedAt";
const USER_FIELDS = "firstName lastName email profile chatSuspended chatUserReadyAt roles";

/** Profile photo URL for CometChat (public bucket object), or undefined without one. */
export const avatarUrl = (profile: unknown) =>
	typeof profile === "string" && profile
		? `https://storage.googleapis.com/${USER_PROFILES_BUCKET}/${profile}`
		: undefined;

/** Creates the CometChat user if it does not exist yet (idempotent) and records that it exists. */
export const ensureChatUser = async (user: any, client: CometChatClient = cometChat) => {
	if (user.chatUserReadyAt) return;
	await client.createUser({
		uid: String(user._id),
		name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "HelpHive user",
		avatar: avatarUrl(user.profile),
		role: user.chatSuspended ? CHAT_SUSPENDED_ROLE : CHAT_MEMBER_ROLE,
	});
	await UserModel.updateOne({ _id: user._id }, { $set: { chatUserReadyAt: new Date() } }).exec();
};

const MAX_TASK_DELAY_MS = 29 * 24 * 60 * 60 * 1000;

/** A Cloud Task that re-checks the pair of this booking when its grace period ends (at most 29 days ahead). */
export const scheduleChatWindowCheck = async (bookingId: string, at: Date) => {
	if (!process.env.GOOGLE_CLOUD_TASKS_SECRET) return;
	const when = new Date(Math.min(at.getTime() + 60_000, Date.now() + MAX_TASK_DELAY_MS));
	// Loaded lazily so tests and scripts that never schedule do not build a Cloud Tasks client.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { googleCloudTasks } = require("../../controllers/service-accounts/cloud-tasks");
	await googleCloudTasks.createTask({
		parent: GOOGLE_CLOUD_TASKS_QUEUE_PATH,
		task: {
			httpRequest: {
				httpMethod: "POST",
				url: `${SERVER_BASE_URL}/webhook/google-cloud-tasks/chat-window`,
				body: Buffer.from(JSON.stringify({ bookingId })).toString("base64"),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.GOOGLE_CLOUD_TASKS_SECRET}`,
				},
			},
			scheduleTime: { seconds: Math.floor(when.getTime() / 1000) },
		},
	});
};

const errorCode = (error: unknown) =>
	error instanceof CometChatError ? error.code : error instanceof Error ? error.name : "unknown";

/** Applies `allowed` to CometChat: friends or not. Creates missing users once if CometChat does not know them. */
const applyToCometChat = async (customer: any, provider: any, allowed: boolean, client: CometChatClient) => {
	const customerUid = String(customer._id);
	const providerUid = String(provider._id);
	if (!allowed) {
		await client.removeFriend(customerUid, providerUid);
		return;
	}
	try {
		await client.addFriend(customerUid, providerUid);
	} catch (error) {
		if (!(error instanceof CometChatError) || error.code !== "ERR_UID_NOT_FOUND") throw error;
		await ensureChatUser({ ...customer, chatUserReadyAt: null }, client);
		await ensureChatUser({ ...provider, chatUserReadyAt: null }, client);
		await client.addFriend(customerUid, providerUid);
	}
};

export interface SyncResult {
	state: PairState;
	changed: boolean;
	synced: boolean;
}

/**
 * Decides whether this customer and provider may chat now, records it (chatlinks) and makes CometChat match. Returns
 * null when either person is missing. Never throws.
 */
export const syncChatPair = async (
	customerId: Id,
	providerId: Id,
	options: { now?: Date; client?: CometChatClient; scheduleCheck?: boolean } = {},
): Promise<SyncResult | null> => {
	const now = options.now ?? new Date();
	const client = options.client ?? cometChat;
	try {
		const [customer, provider, bookings, previous] = await Promise.all([
			UserModel.findById(customerId).select(USER_FIELDS).lean().exec(),
			UserModel.findById(providerId).select(USER_FIELDS).lean().exec(),
			BookingModel.find({ userId: customerId, providerId }).select(BOOKING_FIELDS).lean().exec(),
			ChatLinkModel.findOne({ customerId, providerId }).lean().exec(),
		]);
		if (!customer || !provider) return null;
		const customerIsDemo = isDemoAccountEmail(customer.email);
		const providerIsDemo = isDemoAccountEmail(provider.email);
		const state = decidePair(bookings as any[], { customerIsDemo, providerIsDemo }, now, chatConfig().graceMs);
		const changed = !previous || previous.allowed !== state.allowed;

		// Nothing to record for a pair that never could chat and has no record (e.g. a demo account and a real one).
		if (!previous && !state.allowed && !bookings.some((b: any) => b.providerId)) {
			return { state, changed: false, synced: true };
		}

		let synced = true;
		let syncError: string | null = null;
		if (client.configured) {
			try {
				await applyToCometChat(customer, provider, state.allowed, client);
			} catch (error) {
				synced = false;
				syncError = errorCode(error);
				log.warn("Could not update the chat relationship in CometChat", { code: syncError });
			}
		} else {
			synced = false;
			syncError = "not_configured";
		}

		await ChatLinkModel.updateOne(
			{ customerId, providerId },
			{
				$set: {
					allowed: state.allowed,
					until: state.until,
					bookingIds: state.bookingIds.map((id) => new mongoose.Types.ObjectId(id)),
					demo: customerIsDemo && providerIsDemo,
					synced,
					syncError,
					syncedAt: now,
					...(changed && state.allowed ? { openedAt: now, closedAt: null } : {}),
					...(changed && !state.allowed ? { closedAt: now } : {}),
				},
			},
			{ upsert: true },
		).exec();

		if (changed) {
			emitEvent({
				type: state.allowed ? "chat.relationship_opened" : "chat.relationship_closed",
				actor: { type: "system" },
				subjects: {
					userId: customer._id as any,
					providerId: provider._id as any,
					bookingId: state.bookingIds[0] ?? null,
				},
				properties: { until: state.until, bookings: state.bookingIds.length, synced },
			});
		}

		const untilChanged = (previous?.until?.getTime() ?? null) !== (state.until?.getTime() ?? null);
		if (options.scheduleCheck !== false && state.allowed && state.until && untilChanged && state.bookingIds[0]) {
			await scheduleChatWindowCheck(state.bookingIds[0], state.until).catch((error) =>
				log.warn("Could not schedule the chat window check", { code: errorCode(error) }),
			);
		}
		return { state, changed, synced };
	} catch (error) {
		if (!(error instanceof ChatNotConfiguredError)) log.error("Could not sync a chat relationship", error);
		return null;
	}
};

/** After a booking changed: re-decides the chat of its customer and provider (if it has one). Never throws. */
export const syncBookingChat = async (booking: { userId?: unknown; providerId?: unknown } | null | undefined) => {
	if (!booking?.userId || !booking.providerId) return null;
	return syncChatPair(String(booking.userId), String(booking.providerId));
};

/** Closes this person's relationships whose grace period has passed (lazy sweep when they open chat). */
export const sweepExpiredLinks = async (userId: Id, now = new Date()) => {
	try {
		const due = await ChatLinkModel.find({
			allowed: true,
			until: { $ne: null, $lte: now },
			$or: [{ customerId: userId }, { providerId: userId }],
		})
			.limit(20)
			.lean()
			.exec();
		for (const link of due) await syncChatPair(link.customerId, link.providerId, { now });
	} catch (error) {
		log.error("Could not sweep expired chat relationships", error);
	}
};

/** Whether two people are or were counterparties (any chat link, either way round). */
export const areCounterparties = async (a: Id, b: Id) =>
	!!(await ChatLinkModel.exists({
		$or: [
			{ customerId: a, providerId: b },
			{ customerId: b, providerId: a },
		],
	}));
