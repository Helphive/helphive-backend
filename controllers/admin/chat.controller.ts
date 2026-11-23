// Chat moderation for the admin console: reports (support.read / support.manage) and turning a person's chat off and
// on (users.manage). Responses to the demo admin are masked by the admin router like every other admin response
// (message text is returned as `body`, which the mask hides).
import { Request, Response } from "express";
import UserModel from "../../dal/models/user.model";
import { ChatReportModel, REPORT_STATUSES } from "../../dal/models/chat.model";
import { CHAT_MEMBER_ROLE, CHAT_SUSPENDED_ROLE } from "../../config/chat";
import { REPORT_CATEGORIES } from "../../lib/chat/chatRules";
import { ChatNotConfiguredError, CometChatError, cometChat } from "../../lib/chat/cometchat";
import { revokeAllChatTokens } from "../../lib/chat/chatTokens";
import { parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import log from "../../lib/logger";
import { answerError, loadPeople } from "./operations.shared";

export const CHAT_REPORT_LIST_SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", resolvedAt: "resolvedAt" },
	defaultSort: "-createdAt",
	filters: {
		status: { type: "enum", path: "status", values: REPORT_STATUSES },
		category: { type: "enum", path: "category", values: REPORT_CATEGORIES },
		reporterId: { type: "objectId", path: "reporterId" },
		reportedUserId: { type: "objectId", path: "reportedUserId" },
	},
	dateField: "createdAt",
	maxPageSize: 100,
};

const reportView = (report: any) => ({
	_id: String(report._id),
	reporterId: String(report.reporterId),
	reportedUserId: String(report.reportedUserId),
	category: report.category,
	details: report.details ?? null,
	messageId: report.messageId ?? null,
	message: report.message
		? {
				id: report.message.id,
				type: report.message.type,
				sentAt: report.message.sentAt ?? null,
				body: report.message.body ?? null,
				attachmentTypes: report.message.attachmentTypes ?? [],
			}
		: null,
	status: report.status,
	createdAt: report.createdAt,
	resolvedAt: report.resolvedAt ?? null,
	resolvedBy: report.resolvedBy ? String(report.resolvedBy) : null,
	resolution: report.resolution ?? null,
	purgeAt: report.purgeAt,
});

/** GET /admin/chat/reports: list query (status, category, reporterId, reportedUserId, from/to, sort). */
export const handleListChatReports = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query as Record<string, unknown>, CHAT_REPORT_LIST_SPEC);
		const page = await runListQuery(ChatReportModel, parsed, { map: reportView });
		const people = await loadPeople(page.items.flatMap((r: any) => [r.reporterId, r.reportedUserId]));
		res.json({ ...page, people: Object.fromEntries(people) });
	} catch (error) {
		answerError(res, error, "listing chat reports");
	}
};

const MESSAGES_SHOWN = 50;

/**
 * GET /admin/chat/reports/:id: the report, both people, and the latest messages of their conversation read live from
 * CometChat (null with a reason when chat is not configured or CometChat does not answer).
 */
export const handleGetChatReport = async (req: Request, res: Response) => {
	try {
		const report = await ChatReportModel.findById(req.params.id).lean().exec();
		if (!report) return res.status(404).json({ message: "Report not found." });
		const people = await loadPeople([report.reporterId, report.reportedUserId]);
		let conversation: unknown = null;
		let conversationUnavailable: string | null = null;
		try {
			const messages = await cometChat.listConversationMessages(
				String(report.reporterId),
				String(report.reportedUserId),
				MESSAGES_SHOWN,
			);
			conversation = {
				messages: messages.map((m) => ({
					id: m.id,
					senderId: m.sender,
					sentAt: m.sentAt ? new Date(m.sentAt * 1000) : null,
					type: m.type,
					body: m.text,
					attachmentTypes: m.attachments.map((a) => a.mimeType ?? "unknown"),
					deleted: !!m.deletedAt,
					reported: m.id === report.messageId,
				})),
				limit: MESSAGES_SHOWN,
			};
		} catch (error) {
			conversationUnavailable = error instanceof ChatNotConfiguredError ? "not_configured" : "unavailable";
			if (error instanceof CometChatError) {
				log.warn("read_reported_conversation_failed", "Could not read a reported conversation", {
					status: error.status,
					code: error.code,
				});
			}
		}
		res.json({
			report: reportView(report),
			people: Object.fromEntries(people),
			conversation,
			conversationUnavailable,
		});
	} catch (error) {
		answerError(res, error, "reading a chat report");
	}
};

/** POST /admin/chat/reports/:id/resolve { status: actioned | dismissed, reason } */
export const handleResolveChatReport = async (req: Request, res: Response) => {
	try {
		const status = req.body.status as "actioned" | "dismissed";
		const reason = String(req.body.reason);
		const report = await ChatReportModel.findOneAndUpdate(
			{ _id: req.params.id, status: "open" },
			{ $set: { status, resolvedAt: new Date(), resolvedBy: req.admin!._id, resolution: reason } },
			{ new: true },
		).exec();
		if (!report) {
			const exists = await ChatReportModel.exists({ _id: req.params.id });
			return exists
				? res.status(409).json({ message: "This report is already closed." })
				: res.status(404).json({ message: "Report not found." });
		}
		await recordAudit(
			{
				action: "chat.report_resolved",
				actor: adminActor(req),
				target: { type: "chat_report", id: report._id },
				before: { status: "open" },
				after: { status },
				reason,
				metadata: { category: report.category, reportedUserId: String(report.reportedUserId) },
			},
			req,
		);
		emitEvent(
			{
				type: "chat.report_resolved",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { userId: report.reportedUserId },
				properties: { status },
			},
			req,
		);
		res.json({ report: reportView(report.toObject()) });
	} catch (error) {
		answerError(res, error, "resolving a chat report");
	}
};

const subjectsOf = (user: any) => ({
	userId: user._id,
	...(user.roles?.Provider ? { providerId: user._id } : {}),
});

/**
 * POST /admin/users/:id/chat-suspend { reason }: no chat session is issued from now on, every chat token is revoked,
 * and the person's CometChat role (dashboard: everything denied) blocks them even with a token issued meanwhile.
 */
export const handleSuspendChat = async (req: Request, res: Response) => {
	try {
		const reason = String(req.body.reason);
		const before = await UserModel.findOneAndUpdate(
			{ _id: req.params.id, chatSuspended: { $ne: true } },
			{
				$set: {
					chatSuspended: true,
					chatSuspendedAt: new Date(),
					chatSuspendedBy: req.admin!._id,
					chatSuspendedReason: reason,
				},
				$unset: { "sessions.$[].chatToken": 1 },
			},
			{ new: false },
		).exec();
		if (!before) {
			const exists = await UserModel.exists({ _id: req.params.id });
			return exists
				? res.status(409).json({ message: "Chat is already turned off for this account." })
				: res.status(404).json({ message: "User not found." });
		}
		const uid = String(before._id);
		await revokeAllChatTokens(uid);
		let cometChatUpdated = false;
		if (cometChat.configured) {
			cometChatUpdated = await cometChat.updateUser(uid, { role: CHAT_SUSPENDED_ROLE }).then(
				() => true,
				(error) => {
					log.warn("set_suspended_chat_failed", "Could not set the suspended chat role", {
						code: error?.code ?? "unknown",
					});
					return false;
				},
			);
		}
		await recordAudit(
			{
				action: "users.chat_suspended",
				actor: adminActor(req),
				target: { type: "user", id: before._id },
				before: { chatSuspended: false },
				after: { chatSuspended: true },
				reason,
				metadata: { cometChatUpdated },
			},
			req,
		);
		emitEvent(
			{
				type: "chat.suspended",
				actor: { type: "admin", id: req.admin!._id },
				subjects: subjectsOf(before),
			},
			req,
		);
		res.json({ userId: uid, chatSuspended: true, cometChatUpdated });
	} catch (error) {
		answerError(res, error, "suspending chat");
	}
};

/** POST /admin/users/:id/chat-reinstate { reason } */
export const handleReinstateChat = async (req: Request, res: Response) => {
	try {
		const before = await UserModel.findOneAndUpdate(
			{ _id: req.params.id, chatSuspended: true },
			{
				$set: { chatSuspended: false },
				$unset: { chatSuspendedAt: 1, chatSuspendedBy: 1, chatSuspendedReason: 1 },
			},
			{ new: false },
		).exec();
		if (!before) {
			const exists = await UserModel.exists({ _id: req.params.id });
			return exists
				? res.status(409).json({ message: "Chat is not turned off for this account." })
				: res.status(404).json({ message: "User not found." });
		}
		const uid = String(before._id);
		let cometChatUpdated = false;
		if (cometChat.configured) {
			cometChatUpdated = await cometChat.updateUser(uid, { role: CHAT_MEMBER_ROLE }).then(
				() => true,
				(error) => {
					log.warn("restore_chat_role_failed", "Could not restore the chat role", {
						code: error?.code ?? "unknown",
					});
					return false;
				},
			);
		}
		await recordAudit(
			{
				action: "users.chat_reinstated",
				actor: adminActor(req),
				target: { type: "user", id: before._id },
				before: { chatSuspended: true, chatSuspendedReason: before.chatSuspendedReason ?? null },
				after: { chatSuspended: false },
				reason: String(req.body.reason),
				metadata: { cometChatUpdated },
			},
			req,
		);
		emitEvent(
			{
				type: "chat.reinstated",
				actor: { type: "admin", id: req.admin!._id },
				subjects: subjectsOf(before),
			},
			req,
		);
		res.json({ userId: uid, chatSuspended: false, cometChatUpdated });
	} catch (error) {
		answerError(res, error, "reinstating chat");
	}
};
