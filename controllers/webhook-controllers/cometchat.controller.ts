// CometChat webhook (POST /webhook/cometchat), authenticated with HTTP Basic auth (CometChat's only mechanism; see
// routes/webhook-routes/cometchat.route.ts). Answers 200 at once, as CometChat expects, then:
//  - message_sent: records the message as an event (counts and kinds, never the text), deletes it if it breaks the
//    rules (attachment type or size, or no booking relationship between the two people), and pushes a notification
//    to the receiver's signed-in devices (lib/push.ts): only while the two may chat, never across a block, not while
//    the receiver has that conversation open, at most one per conversation per CHAT_PUSH_MIN_INTERVAL_SECONDS
//    (never for a booking event the server sent itself: the booking notifications cover those, and it is not counted as a
//    message a person sent);
//  - user_blocked / user_unblocked: mirrors blocks made inside the chat UI, so pushes respect them.
// Everything else is acknowledged and ignored.
import { Request, Response } from "express";
import mongoose from "mongoose";
import UserModel from "../../dal/models/user.model";
import WebhookEventModel from "../../dal/models/webhookEvent.model";
import { ChatBlockModel, ChatLinkModel } from "../../dal/models/chat.model";
import { chatConfig } from "../../config/chat";
import { cometChat, toChatMessage, type ChatMessage } from "../../lib/chat/cometchat";
import { attachmentViolation, messageMetadata, shouldPushChatMessage, webhookEventKey } from "../../lib/chat/chatRules";
import { syncChatPair } from "../../lib/chat/chatSync";
import { isGenuineBookingEvent } from "../../lib/chat/eventAuthorship";
import { chatPushContent } from "../../lib/push";
import { webAppUrl } from "../../lib/appIdentity";
import { TtlCache } from "../../lib/places";
import { sendNotification } from "../service-accounts/onesignal";
import { emitEvent } from "../../lib/events";
import { getRequestContext, runWithContext } from "../../lib/requestContext";
import log from "../../lib/logger";

// One push per conversation per receiver within the interval (per instance); the device collapses the rest
// (collapse_id), so a burst of messages shows as one notification.
const recentPushes = new TtlCache<boolean>(chatConfig().pushMinIntervalMs, 20_000);

const isObjectId = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);

/** Records the delivery; false when this message was already handled (CometChat retried). */
const firstDelivery = async (key: string | null, trigger: string): Promise<boolean> => {
	if (!key) return true;
	const now = new Date();
	try {
		const result = await WebhookEventModel.updateOne(
			{ provider: "cometchat", eventId: key },
			{
				$setOnInsert: {
					provider: "cometchat",
					endpoint: "chat",
					eventId: key,
					type: trigger,
					receivedAt: now,
					processedAt: now,
					outcome: "processed",
					requestId: getRequestContext()?.requestId ?? null,
				},
				$inc: { deliveries: 1 },
				$set: { lastDeliveryAt: now },
			},
			{ upsert: true },
		).exec();
		return result.upsertedCount === 1;
	} catch (error) {
		// If recording fails, process anyway: a rare double push beats a lost message event.
		log.error("Could not record a CometChat webhook delivery", error);
		return true;
	}
};

const removeMessage = async (message: ChatMessage, reason: string) => {
	try {
		await cometChat.deleteMessage(message.id, message.sender);
		emitEvent({
			type: "chat.message_removed",
			actor: { type: "system" },
			subjects: { userId: isObjectId(message.sender) ? message.sender : null },
			properties: { messageId: message.id, reason },
		});
		return true;
	} catch (error: any) {
		log.warn("Could not delete a chat message that breaks the rules", { code: error?.code ?? "unknown", reason });
		return false;
	}
};

const handleMessageSent = async (data: any) => {
	const message = toChatMessage(data?.message);
	if (!message) return;
	if (!(await firstDelivery(webhookEventKey("message_sent", data), "message_sent"))) return;
	const config = chatConfig();
	// Only a message the server itself sent as a booking event is exempt (a person can send the same metadata and text).
	const genuineEvent = await isGenuineBookingEvent(message);

	const sender = isObjectId(message.sender)
		? await UserModel.findById(message.sender).select("firstName roles chatSuspended suspended").lean().exec()
		: null;
	const receiver =
		message.receiverType === "user" && isObjectId(message.receiver)
			? await UserModel.findById(message.receiver)
					.select("roles chatSuspended suspended sessions.chatViewing")
					.lean()
					.exec()
			: null;

	// Whether these two may chat now: a customer and a provider who share a booking in its window.
	const provider = sender?.roles?.Provider ? sender : receiver?.roles?.Provider ? receiver : null;
	const customer = provider === sender ? receiver : sender;
	let allowed: boolean | null = null;
	if (provider && customer && provider !== customer) {
		const link = await ChatLinkModel.findOne({ customerId: customer._id, providerId: provider._id }).lean().exec();
		if (link) allowed = link.allowed;
		else {
			// No record yet (before the reconciliation script ran): decide from the bookings now, and record it.
			const result = await syncChatPair(customer._id as any, provider._id as any);
			allowed = result ? result.state.allowed : null;
		}
	} else if (sender || receiver) {
		allowed = false;
	}

	let removed = false;
	if (config.enforceOnWebhook) {
		const violation = attachmentViolation(message, config.attachments);
		if (violation) removed = await removeMessage(message, `attachment_${violation}`);
		// An unknown (database error) never deletes a message.
		if (!removed && message.category === "message" && (message.receiverType !== "user" || allowed === false)) {
			removed = await removeMessage(message, "no_relationship");
		}
	}

	let pushed = false;
	if (sender && receiver) {
		const senderUid = String(sender._id);
		const blocked = await ChatBlockModel.exists({
			$or: [
				{ blockerId: receiver._id, blockedId: sender._id },
				{ blockerId: sender._id, blockedId: receiver._id },
			],
		});
		const now = Date.now();
		const viewing = ((receiver as any).sessions ?? []).some(
			(s: any) => s?.chatViewing?.withUid === senderUid && new Date(s.chatViewing.until).getTime() > now,
		);
		const pairKey = `${String(receiver._id)}|${senderUid}`;
		if (
			shouldPushChatMessage({
				enabled: config.push,
				receiverType: message.receiverType,
				allowed: allowed === true,
				viewingConversation: viewing,
				recentlyPushed: !!recentPushes.get(pairKey),
				blockedEitherWay: !!blocked,
				receiverChatSuspended: !!receiver.chatSuspended || !!receiver.suspended,
				removed,
				bookingEvent: genuineEvent,
			})
		) {
			recentPushes.set(pairKey, true);
			// Only the receiver's devices that are still signed in get it (sendNotification resolves their sessions).
			const result = await sendNotification({
				include_aliases: { external_id: [String(receiver._id)] },
				...chatPushContent({
					senderFirstName: sender.firstName,
					senderUid,
					text: message.text,
					type: message.type,
					preview: config.pushPreview,
					webAppUrl: webAppUrl(),
				}),
			});
			pushed = !!result;
		}
	}

	// Booking events the server sent are system content: not counted as something a person sent.
	if (genuineEvent) return;
	const providerId = sender?.roles?.Provider ? sender._id : receiver?.roles?.Provider ? receiver._id : null;
	emitEvent({
		type: "chat.message_sent",
		actor: sender
			? { type: sender.roles?.Provider ? "provider" : "user", id: sender._id as any }
			: { type: "anonymous" },
		subjects: { userId: (sender?._id as any) ?? null, providerId: providerId as any },
		properties: {
			...messageMetadata(message),
			senderRole: sender ? (sender.roles?.Provider ? "provider" : "customer") : "unknown",
			pushed,
			removed,
		},
	});
};

const handleBlockChange = async (trigger: "user_blocked" | "user_unblocked", data: any) => {
	const by = data?.by?.uid;
	const users = data?.users && typeof data.users === "object" ? Object.keys(data.users) : [];
	if (!isObjectId(by)) return;
	for (const target of users.filter(isObjectId).slice(0, 50)) {
		const filter = { blockerId: new mongoose.Types.ObjectId(by), blockedId: new mongoose.Types.ObjectId(target) };
		if (trigger === "user_blocked") {
			await ChatBlockModel.updateOne(
				filter,
				{ $setOnInsert: { source: "chat", createdAt: new Date() } },
				{ upsert: true },
			).exec();
		} else {
			await ChatBlockModel.deleteOne(filter).exec();
		}
		emitEvent({
			type: trigger === "user_blocked" ? "chat.user_blocked" : "chat.user_unblocked",
			actor: { type: "user", id: by },
			subjects: { userId: by },
			properties: { source: "chat" },
		});
	}
};

export const processCometChatWebhook = async (payload: any) => {
	const trigger = typeof payload?.trigger === "string" ? payload.trigger : "";
	switch (trigger) {
		case "message_sent":
			return handleMessageSent(payload.data);
		case "user_blocked":
		case "user_unblocked":
			return handleBlockChange(trigger, payload.data);
		default:
			return undefined;
	}
};

/** POST /webhook/cometchat (after Basic auth). */
export const handleCometChatWebhook = (req: Request, res: Response) => {
	const config = chatConfig();
	// Deliveries for another CometChat app (a copied webhook) are acknowledged and ignored.
	if (
		config.appId &&
		typeof req.body?.appId === "string" &&
		req.body.appId.toLowerCase() !== config.appId.toLowerCase()
	) {
		return res.status(200).json({ received: true, ignored: true });
	}
	res.status(200).json({ received: true });
	const context = req.context;
	const payload = req.body;
	setImmediate(() => {
		const run = () =>
			processCometChatWebhook(payload).catch((error) => log.error("Error handling a CometChat webhook", error));
		if (context) runWithContext(context, run);
		else run();
	});
};
