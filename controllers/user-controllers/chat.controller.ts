// Chat for signed-in customers and providers (routes/user-routes/chat.route.ts): server-issued CometChat sessions,
// the conversation for a booking, contacts, the unread badge, reports and blocks. The contract for the apps is in
// scratch/chat/chat-contract.md. Message text is never logged.
import { Request, Response } from "express";
import mongoose from "mongoose";
import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import { ChatBlockModel, ChatLinkModel, ChatReportModel } from "../../dal/models/chat.model";
import { chatConfig } from "../../config/chat";
import { ChatNotConfiguredError, CometChatError, cometChat } from "../../lib/chat/cometchat";
import {
	chatSessionRefusal,
	counterpartyDecision,
	pairChatState,
	reportedMessageMatches,
} from "../../lib/chat/chatRules";
import {
	areCounterparties,
	avatarUrl,
	ensureChatUser,
	sweepExpiredLinks,
	syncBookingChat,
} from "../../lib/chat/chatSync";
import { openChatToken, sealChatToken, revokeChatToken } from "../../lib/chat/chatTokens";
import { TtlCache } from "../../lib/places";
import { emitEvent, userActorType } from "../../lib/events";
import { isValidObjectId } from "./utils/booking.utils";
import log from "../../lib/logger";

const NOT_CONFIGURED = { message: "Chat is not available right now.", code: "chat_not_configured" };
const UNAVAILABLE = { message: "Chat is temporarily unavailable. Try again shortly.", code: "chat_unavailable" };

const answer = (res: Response, error: unknown, what: string) => {
	if (error instanceof ChatNotConfiguredError) return res.status(503).json(NOT_CONFIGURED);
	if (error instanceof CometChatError) {
		log.warn(`Chat request failed (${what})`, { status: error.status, code: error.code });
		return res.status(502).json(UNAVAILABLE);
	}
	log.error(`Error ${what}`, error);
	return res.status(500).json({ message: "An error occurred while processing request." });
};

const currentUser = (req: Request) => UserModel.findOne({ email: req.user }).exec();

const subjectsFor = (user: { _id: unknown; roles?: { Provider?: boolean } | null }) => ({
	userId: user._id as any,
	...(user.roles?.Provider ? { providerId: user._id as any } : {}),
});

/**
 * POST /auth/chat/session: a CometChat auth token for this sign-in session (the same one on repeat calls), with the
 * app id and region the client initialises with. Refused for suspended accounts, unverified emails and chat-suspended
 * people. No auth key or REST key is ever sent to a client.
 */
export const handleChatSession = async (req: Request, res: Response) => {
	try {
		const config = chatConfig();
		if (!config.configured) return res.status(503).json(NOT_CONFIGURED);
		const user = await currentUser(req);
		if (!user) return res.status(404).json({ message: "User not found." });
		const refusal = chatSessionRefusal(user);
		if (refusal) return res.status(refusal.status).json({ message: refusal.message, code: refusal.code });

		const uid = String(user._id);
		const session = user.sessions.find((s) => s.sessionId === req.sessionId);
		let authToken = openChatToken(session?.chatToken);
		const issued = !authToken;
		if (!authToken) {
			await ensureChatUser(user);
			authToken = await cometChat.createAuthToken(uid);
			if (session) {
				await UserModel.updateOne(
					{ _id: user._id, "sessions.sessionId": req.sessionId },
					{ $set: { "sessions.$.chatToken": sealChatToken(authToken) } },
				).exec();
			}
			emitEvent(
				{
					type: "chat.session_issued",
					actor: { type: userActorType(user), id: user._id },
					subjects: subjectsFor(user),
					properties: { role: user.roles?.Provider ? "provider" : "customer" },
				},
				req,
			);
		}
		// Close any relationship whose grace period ended (the scheduled check may have failed).
		void sweepExpiredLinks(user._id as any);
		res.json({
			chat: { provider: "cometchat", appId: config.appId, region: config.region, uid, authToken, issued },
		});
	} catch (error) {
		answer(res, error, "issuing a chat session");
	}
};

/** POST /auth/chat/session/end: revokes this session's chat token (sign-out also does it). 204. */
export const handleEndChatSession = async (req: Request, res: Response) => {
	try {
		const user = await currentUser(req);
		if (!user) return res.sendStatus(204);
		const session = user.sessions.find((s) => s.sessionId === req.sessionId);
		if (session?.chatToken) {
			revokeChatToken(String(user._id), session.chatToken);
			await UserModel.updateOne(
				{ _id: user._id, "sessions.sessionId": req.sessionId },
				{ $unset: { "sessions.$.chatToken": 1 } },
			).exec();
		}
		res.sendStatus(204);
	} catch (error) {
		answer(res, error, "ending a chat session");
	}
};

const counterpartyView = (person: any) =>
	person
		? {
				uid: String(person._id),
				firstName: person.firstName,
				lastName: person.lastName,
				profile: person.profile ?? null,
				avatar: avatarUrl(person.profile) ?? null,
			}
		: null;

/**
 * GET /auth/chat/bookings/:bookingId/conversation: who to open a conversation with for this booking, and whether
 * chat is open (and until when). Only the booking's customer and its provider may ask.
 */
export const handleBookingConversation = async (req: Request, res: Response) => {
	try {
		const user = await currentUser(req);
		if (!user) return res.status(404).json({ message: "User not found." });
		const booking = await BookingModel.findById(req.params.bookingId).exec();
		if (!booking) return res.status(404).json({ message: "Booking not found." });
		const me = String(user._id);
		const isCustomer = String(booking.userId) === me;
		const isProvider = !!booking.providerId && String(booking.providerId) === me;
		if (!isCustomer && !isProvider) {
			return res.status(403).json({ message: "User not authorized to view this booking." });
		}
		if (!booking.providerId) {
			return res.json({
				conversation: null,
				reason: "not_accepted",
				message: "Chat opens when a provider accepts the booking.",
			});
		}
		const otherId = isCustomer ? booking.providerId : booking.userId;
		const [other, link, bookings] = await Promise.all([
			UserModel.findById(otherId).select("firstName lastName profile").lean().exec(),
			ChatLinkModel.findOne({ customerId: booking.userId, providerId: booking.providerId }).lean().exec(),
			BookingModel.find({ userId: booking.userId, providerId: booking.providerId })
				.select("status userId providerId completedAt cancelledAt updatedAt")
				.lean()
				.exec(),
		]);
		// Decided from the bookings now (the stored link can lag a moment behind a change); re-synced if it differs.
		const state = pairChatState(bookings as any[], new Date(), chatConfig().graceMs);
		if (!link || link.allowed !== state.allowed) void syncBookingChat(booking);
		res.json({
			conversation: {
				type: "user",
				withUid: String(otherId),
				counterparty: counterpartyView(other),
				open: state.allowed,
				until: state.until,
				bookingId: String(booking._id),
			},
			reason: state.allowed ? null : "closed",
		});
	} catch (error) {
		answer(res, error, "finding the booking conversation");
	}
};

/** GET /auth/chat/contacts: the people this user may chat with now. */
export const handleChatContacts = async (req: Request, res: Response) => {
	try {
		const user = await currentUser(req);
		if (!user) return res.status(404).json({ message: "User not found." });
		await sweepExpiredLinks(user._id as any);
		const links = await ChatLinkModel.find({
			allowed: true,
			$or: [{ customerId: user._id }, { providerId: user._id }],
		})
			.limit(200)
			.lean()
			.exec();
		const otherIds = links.map((l) => (String(l.customerId) === String(user._id) ? l.providerId : l.customerId));
		const people = await UserModel.find({ _id: { $in: otherIds } })
			.select("firstName lastName profile")
			.lean()
			.exec();
		const byId = new Map(people.map((p: any) => [String(p._id), p]));
		res.json({
			contacts: links
				.map((link, i) => ({
					...counterpartyView(byId.get(String(otherIds[i]))),
					role: String(link.customerId) === String(user._id) ? "provider" : "customer",
					until: link.until,
					bookingIds: link.bookingIds.map(String),
				}))
				.filter((contact) => contact.uid),
		});
	} catch (error) {
		answer(res, error, "listing chat contacts");
	}
};

// The badge is polled; each person's count is reused for 15 seconds (per instance).
const unreadCache = new TtlCache<{ unreadCount: number; conversations: number }>(15_000, 10_000);

/** GET /auth/chat/unread-count: for the navigation badge, without loading the chat library. */
export const handleChatUnreadCount = async (req: Request, res: Response) => {
	try {
		if (!cometChat.configured) return res.status(503).json(NOT_CONFIGURED);
		const user = await UserModel.findOne({ email: req.user }).select("_id chatSuspended").lean().exec();
		if (!user) return res.status(404).json({ message: "User not found." });
		if (user.chatSuspended) return res.json({ unreadCount: 0, conversations: 0 });
		const uid = String(user._id);
		let counts = unreadCache.get(uid);
		if (!counts) {
			counts = await cometChat.unreadCount(uid);
			unreadCache.set(uid, counts);
		}
		res.json(counts);
	} catch (error) {
		// A user CometChat does not know yet has nothing unread.
		if (error instanceof CometChatError && error.code === "ERR_UID_NOT_FOUND") {
			return res.json({ unreadCount: 0, conversations: 0 });
		}
		answer(res, error, "counting unread chat messages");
	}
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * POST /auth/chat/reports { reportedUid, category, details?, messageId? }: to HelpHive's admins. With a message id,
 * the message must be one the reported person sent to the reporter; a copy of it is kept with the report.
 */
export const handleCreateReport = async (req: Request, res: Response) => {
	try {
		const user = await currentUser(req);
		if (!user) return res.status(404).json({ message: "User not found." });
		const me = String(user._id);
		const { reportedUid, category, details, messageId } = req.body;
		const decision = counterpartyDecision({
			selfId: me,
			targetId: reportedUid,
			related: reportedUid !== me && (await areCounterparties(me, reportedUid)),
		});
		if (decision === "self") return res.status(400).json({ message: "You cannot report yourself.", code: "self" });
		if (decision === "not_counterparty") {
			return res
				.status(403)
				.json({ message: "You can only report people you have a booking with.", code: "not_counterparty" });
		}

		if (messageId) {
			const existing = await ChatReportModel.findOne({ reporterId: user._id, messageId }).lean().exec();
			if (existing) return res.json({ report: { _id: existing._id, status: existing.status }, duplicate: true });
		}

		let message: any = null;
		if (messageId) {
			const fetched = await cometChat.getMessage(messageId, me).catch((error) => {
				if (error instanceof CometChatError && error.status === 404) return null;
				throw error;
			});
			if (!reportedMessageMatches(fetched, me, reportedUid)) {
				return res.status(400).json({
					message: "That message was not sent to you by this person.",
					code: "message_mismatch",
				});
			}
			message = {
				id: fetched!.id,
				type: fetched!.type,
				sentAt: fetched!.sentAt ? new Date(fetched!.sentAt * 1000) : null,
				body: fetched!.text ? fetched!.text.slice(0, 5000) : null,
				attachmentTypes: fetched!.attachments.map((a) => a.mimeType ?? "unknown"),
			};
		}

		const now = new Date();
		const report = await ChatReportModel.create({
			reporterId: user._id,
			reportedUserId: new mongoose.Types.ObjectId(reportedUid),
			category,
			details: typeof details === "string" && details.trim() ? details.trim() : null,
			messageId: messageId ?? null,
			message,
			status: "open",
			createdAt: now,
			purgeAt: new Date(now.getTime() + Math.max(chatConfig().retentionMs, 30 * DAY)),
		});
		emitEvent(
			{
				type: "chat.message_reported",
				actor: { type: userActorType(user), id: user._id },
				subjects: { userId: user._id as any },
				properties: { category, withMessage: !!message },
			},
			req,
		);
		res.status(201).json({ report: { _id: report._id, status: report.status } });
	} catch (error) {
		answer(res, error, "creating a chat report");
	}
};

/** GET /auth/chat/blocks: the people this user blocked. */
export const handleListBlocks = async (req: Request, res: Response) => {
	try {
		const user = await currentUser(req);
		if (!user) return res.status(404).json({ message: "User not found." });
		const blocks = await ChatBlockModel.find({ blockerId: user._id })
			.sort({ createdAt: -1 })
			.limit(500)
			.lean()
			.exec();
		res.json({ blocked: blocks.map((b) => ({ uid: String(b.blockedId), at: b.createdAt })) });
	} catch (error) {
		answer(res, error, "listing chat blocks");
	}
};

/** POST /auth/chat/blocks { uid }: blocks a counterparty here and in CometChat (both directions stop). */
export const handleBlockUser = async (req: Request, res: Response) => {
	try {
		const user = await currentUser(req);
		if (!user) return res.status(404).json({ message: "User not found." });
		const me = String(user._id);
		const target = String(req.body.uid);
		const decision = counterpartyDecision({
			selfId: me,
			targetId: target,
			related: target !== me && (await areCounterparties(me, target)),
		});
		if (decision === "self") return res.status(400).json({ message: "You cannot block yourself.", code: "self" });
		if (decision === "not_counterparty") {
			return res
				.status(403)
				.json({ message: "You can only block people you have a booking with.", code: "not_counterparty" });
		}
		const result = await ChatBlockModel.updateOne(
			{ blockerId: user._id, blockedId: new mongoose.Types.ObjectId(target) },
			{ $setOnInsert: { source: "api", createdAt: new Date() } },
			{ upsert: true },
		).exec();
		let synced = true;
		if (cometChat.configured) {
			await cometChat.blockUser(me, target).catch((error) => {
				synced = false;
				log.warn("Could not block in CometChat", { code: error?.code ?? "unknown" });
			});
		}
		if (result.upsertedCount) {
			emitEvent(
				{
					type: "chat.user_blocked",
					actor: { type: userActorType(user), id: user._id },
					subjects: { userId: user._id as any },
					properties: { source: "api" },
				},
				req,
			);
		}
		res.status(result.upsertedCount ? 201 : 200).json({ blocked: { uid: target }, synced });
	} catch (error) {
		answer(res, error, "blocking a chat user");
	}
};

/** DELETE /auth/chat/blocks/:uid */
export const handleUnblockUser = async (req: Request, res: Response) => {
	try {
		const user = await currentUser(req);
		if (!user) return res.status(404).json({ message: "User not found." });
		const target = req.params.uid;
		if (!isValidObjectId(target)) return res.status(400).json({ message: "Invalid user id." });
		const removed = await ChatBlockModel.deleteOne({ blockerId: user._id, blockedId: target }).exec();
		let synced = true;
		if (cometChat.configured) {
			await cometChat.unblockUser(String(user._id), target).catch((error) => {
				synced = false;
				log.warn("Could not unblock in CometChat", { code: error?.code ?? "unknown" });
			});
		}
		if (removed.deletedCount) {
			emitEvent(
				{
					type: "chat.user_unblocked",
					actor: { type: userActorType(user), id: user._id },
					subjects: { userId: user._id as any },
					properties: { source: "api" },
				},
				req,
			);
		}
		res.json({ unblocked: { uid: target }, synced });
	} catch (error) {
		answer(res, error, "unblocking a chat user");
	}
};

/** How long a "viewing" signal lasts; the app repeats it every 60 seconds while the conversation is open. */
export const VIEWING_TTL_MS = 90_000;

/**
 * PUT /auth/chat/viewing { withUid | null }: this device has the conversation with `withUid` open (no push for it), or
 * none. Expires by itself after 90 seconds, so a crashed app does not silence notifications for long.
 */
export const handleChatViewing = async (req: Request, res: Response) => {
	try {
		const withUid = req.body.withUid ?? null;
		const user = await UserModel.findOne({ email: req.user }).select("_id").lean().exec();
		if (!user) return res.status(404).json({ message: "User not found." });
		const until = new Date(Date.now() + VIEWING_TTL_MS);
		await UserModel.updateOne(
			{ _id: user._id, "sessions.sessionId": req.sessionId },
			withUid
				? { $set: { "sessions.$.chatViewing": { withUid, until } } }
				: { $unset: { "sessions.$.chatViewing": 1 } },
		).exec();
		res.json({ viewing: withUid, until: withUid ? until : null });
	} catch (error) {
		answer(res, error, "recording the open conversation");
	}
};
