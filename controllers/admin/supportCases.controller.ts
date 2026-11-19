// Support cases: open, list, read, change, note, message the customer or provider (email under the outbound email
// policy), link refunds and other actions, resolve. Every write is audited and emits an event.
import type { Request, Response } from "express";
import mongoose from "mongoose";
import SupportCaseModel from "../../dal/models/supportCase.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import UserModel from "../../dal/models/user.model";
import AdminModel from "../../dal/models/admin.model";
import { parseListQuery, runListQuery, ListQueryError, type ListSpec } from "../../lib/listQuery";
import {
	CASE_CATEGORIES,
	CASE_PRIORITIES,
	CASE_STATUSES,
	OPEN_STATUSES,
	canChangeStatus,
	caseMessageSubject,
	caseReference,
	partiesOf,
} from "../../lib/supportCases";
import { adminActor, recordAudit, type AuditAction } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import { sendEmail } from "../../lib/email";
import { SUPPORT_EMAIL } from "../../config/config";
import { effectiveRole, hasPermission } from "../../config/adminPermissions";
import { PlainMessageEmail } from "../../emails/plainMessageEmail";
import { bookingReference } from "../../lib/operations";
import { DETAIL_TIME_LIMIT_MS, answerError, auditFor, loadPeople, oid, takeParams } from "./operations.shared";

const time = DETAIL_TIME_LIMIT_MS;

export const CASE_LIST_SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", lastActivityAt: "lastActivityAt", priority: "priority" },
	defaultSort: "-lastActivityAt",
	filters: {
		status: { type: "enum", path: "status", values: CASE_STATUSES },
		category: { type: "enum", path: "category", values: CASE_CATEGORIES },
		priority: { type: "enum", path: "priority", values: CASE_PRIORITIES },
		bookingId: { type: "objectId", path: "bookingId" },
		paymentId: { type: "objectId", path: "paymentId" },
		userId: { type: "objectId", path: "parties.userId" },
		open: {
			type: "custom",
			parse: (v) =>
				v === "true"
					? { status: { $in: [...OPEN_STATUSES] } }
					: v === "false"
						? { status: { $nin: [...OPEN_STATUSES] } }
						: null,
		},
	},
	dateField: "createdAt",
	searchFields: ["reference", "subject"],
	maxPageSize: 100,
};

const by = (req: Request) => ({ id: req.admin!._id, email: req.admin!.email });

const subjectsOf = (c: any) => ({
	userId: c.userId ?? c.parties?.[0]?.userId,
	bookingId: c.bookingId,
	paymentId: c.paymentId,
});

const listItem = (c: any) => ({
	_id: String(c._id),
	reference: c.reference,
	category: c.category,
	subject: c.subject,
	status: c.status,
	priority: c.priority,
	source: c.source,
	assignee: c.assignee?.id ? { id: String(c.assignee.id), email: c.assignee.email } : null,
	bookingId: c.bookingId ? String(c.bookingId) : null,
	bookingReference: c.bookingId ? bookingReference(c.bookingId) : null,
	paymentId: c.paymentId ? String(c.paymentId) : null,
	userId: c.userId ? String(c.userId) : null,
	parties: (c.parties ?? []).map((p: any) => ({ role: p.role, userId: String(p.userId) })),
	counts: { notes: c.notes?.length ?? 0, messages: c.messages?.length ?? 0, actions: c.actions?.length ?? 0 },
	resolution: c.resolution ?? null,
	createdAt: c.createdAt,
	lastActivityAt: c.lastActivityAt,
});

/** GET /admin/cases (assignee=me|none|<admin id> as well as the list filters) */
export const handleListCases = async (req: Request, res: Response) => {
	try {
		const { rest, values } = takeParams(req.query as Record<string, unknown>, ["assignee"]);
		const parsed = parseListQuery(rest, CASE_LIST_SPEC);
		let base: Record<string, unknown> | undefined;
		if (values.assignee === "me") base = { "assignee.id": req.admin!._id };
		else if (values.assignee === "none") base = { assignee: null };
		else if (values.assignee) {
			if (!/^[a-f\d]{24}$/i.test(values.assignee))
				throw new ListQueryError("assignee must be me, none or an admin id.", "assignee");
			base = { "assignee.id": oid(values.assignee) };
		}
		const page = await runListQuery(SupportCaseModel, parsed, {
			baseFilter: base,
			projection: { description: 0, "notes.body": 0, "messages.body": 0 },
		});
		const people = await loadPeople(page.items.flatMap((c: any) => (c.parties ?? []).map((p: any) => p.userId)));
		const [open, mine, unassigned] = await Promise.all([
			SupportCaseModel.countDocuments({ status: { $in: [...OPEN_STATUSES] } })
				.maxTimeMS(time)
				.exec(),
			SupportCaseModel.countDocuments({ status: { $in: [...OPEN_STATUSES] }, "assignee.id": req.admin!._id })
				.maxTimeMS(time)
				.exec(),
			SupportCaseModel.countDocuments({ status: { $in: [...OPEN_STATUSES] }, assignee: null })
				.maxTimeMS(time)
				.exec(),
		]);
		res.json({
			...page,
			items: page.items.map((c: any) => ({
				...listItem(c),
				people: (c.parties ?? []).map((p: any) => ({
					role: p.role,
					person: people.get(String(p.userId)) ?? null,
				})),
			})),
			counts: { open, mine, unassigned },
		});
	} catch (error) {
		answerError(res, error, "listing cases");
	}
};

/** GET /admin/cases/assignees : admins who can work cases (support.manage). */
export const handleListAssignees = async (_req: Request, res: Response) => {
	try {
		const admins = await AdminModel.find({ disabled: { $ne: true } }, "firstName lastName email role roles")
			.maxTimeMS(time)
			.lean()
			.exec();
		res.json({
			items: admins
				.filter((a: any) => hasPermission(a, "support.manage"))
				.map((a: any) => ({
					_id: String(a._id),
					name: `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim(),
					email: a.email,
					role: effectiveRole(a),
				})),
		});
	} catch (error) {
		answerError(res, error, "listing assignees");
	}
};

const caseDetail = async (req: Request, c: any) => {
	const [people, booking, payment, audit] = await Promise.all([
		loadPeople((c.parties ?? []).map((p: any) => p.userId)),
		c.bookingId
			? BookingModel.findById(c.bookingId, "service startDate status hours rate userApprovalRequested providerId")
					.lean()
					.exec()
			: null,
		c.paymentId
			? PaymentModel.findById(c.paymentId, "amount status refundStatus refundAmount createdAt").lean().exec()
			: null,
		auditFor(req, "supportCase", c._id),
	]);
	return {
		case: {
			...listItem(c),
			description: c.description,
			openedBy: c.openedBy,
			notes: (c.notes ?? []).map((n: any) => ({ ...n, _id: String(n._id) })),
			messages: (c.messages ?? []).map((m: any) => ({
				_id: String(m._id),
				to: m.to,
				userId: String(m.userId),
				subject: m.subject,
				body: m.body,
				channel: m.channel,
				result: m.result,
				skippedBecause: m.skippedBecause ?? null,
				by: m.by,
				at: m.at,
			})),
			actions: (c.actions ?? []).map((a: any) => ({ ...a, _id: String(a._id) })),
			version: c.version,
		},
		people: (c.parties ?? []).map((p: any) => ({ role: p.role, person: people.get(String(p.userId)) ?? null })),
		booking: booking
			? {
					_id: String((booking as any)._id),
					reference: bookingReference((booking as any)._id),
					service: (booking as any).service,
					startDate: (booking as any).startDate,
					status: (booking as any).status,
					amount: (booking as any).rate * (booking as any).hours,
				}
			: null,
		payment: payment
			? {
					_id: String((payment as any)._id),
					amount: (payment as any).amount,
					status: (payment as any).status,
					refundStatus: (payment as any).refundStatus ?? null,
					refundAmount: (payment as any).refundAmount ?? 0,
				}
			: null,
		audit,
	};
};

/** GET /admin/cases/:id */
export const handleGetCase = async (req: Request, res: Response) => {
	try {
		const c = await SupportCaseModel.findById(req.params.id).maxTimeMS(time).lean().exec();
		if (!c) return res.status(404).json({ message: "Case not found." });
		res.json(await caseDetail(req, c));
	} catch (error) {
		answerError(res, error, "getting case");
	}
};

const auditCase = (
	req: Request,
	action: AuditAction,
	c: any,
	extra: { before?: unknown; after?: unknown; reason?: string | null; outcome?: "success" | "failure" },
) => recordAudit({ action, actor: adminActor(req), target: { type: "supportCase", id: String(c._id) }, ...extra }, req);

const findAdmin = async (id: unknown) => {
	if (id === null) return null;
	if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) return undefined;
	const admin = await AdminModel.findById(id, "email role roles disabled").lean().exec();
	return admin && !(admin as any).disabled && hasPermission(admin as any, "support.manage")
		? { id: (admin as any)._id, email: (admin as any).email as string }
		: undefined;
};

/** POST /admin/cases { category, subject, description, priority?, bookingId?, paymentId?, userId?, assigneeId? } */
export const handleOpenCase = async (req: Request, res: Response) => {
	try {
		const { category, subject, description, priority, bookingId, paymentId, userId, assigneeId } = req.body;
		const [payment, user] = await Promise.all([
			paymentId ? PaymentModel.findById(paymentId, "bookingId").lean().exec() : null,
			userId ? UserModel.findById(userId, "_id roles").lean().exec() : null,
		]);
		if (paymentId && !payment) return res.status(404).json({ message: "Payment not found." });
		if (userId && !user) return res.status(404).json({ message: "User not found." });
		const effectiveBookingId = bookingId ?? (payment ? String((payment as any).bookingId) : null);
		const booking = effectiveBookingId
			? await BookingModel.findById(effectiveBookingId, "userId providerId").lean().exec()
			: null;
		if (effectiveBookingId && !booking) return res.status(404).json({ message: "Booking not found." });
		if (!booking && !user)
			return res.status(400).json({ message: "Link the case to a booking, a payment or a person." });
		const assignee = assigneeId === undefined ? null : await findAdmin(assigneeId);
		if (assignee === undefined)
			return res
				.status(400)
				.json({ message: "The assignee must be an active admin who can work cases.", field: "assigneeId" });

		const _id = new mongoose.Types.ObjectId();
		const now = new Date();
		const c = await SupportCaseModel.create({
			_id,
			reference: caseReference(_id),
			category,
			subject: String(subject).trim(),
			description: String(description).trim(),
			source: "admin",
			openedBy: { actorType: "admin", id: req.admin!._id, email: req.admin!.email },
			status: "open",
			priority: priority ?? "normal",
			assignee,
			bookingId: booking ? (booking as any)._id : null,
			paymentId: payment ? (payment as any)._id : null,
			userId: user ? (user as any)._id : null,
			parties: partiesOf({ booking: booking as any, user: user as any }).map((p) => ({
				role: p.role,
				userId: oid(p.userId),
			})),
			lastActivityAt: now,
			version: 1,
		});
		await auditCase(req, "support.case_opened", c, {
			after: {
				reference: c.reference,
				category,
				subject: c.subject,
				priority: c.priority,
				assignee: assignee?.email ?? null,
			},
		});
		emitEvent(
			{
				type: "support.case_opened",
				actor: { type: "admin", id: req.admin!._id },
				subjects: subjectsOf(c),
				properties: { caseId: String(c._id), reference: c.reference, category, source: "admin" },
			},
			req,
		);
		res.status(201).json(await caseDetail(req, c.toObject()));
	} catch (error) {
		answerError(res, error, "opening case");
	}
};

/** PATCH /admin/cases/:id { status?, priority?, category?, assigneeId? (null to unassign), reason?, expectedVersion? } */
export const handleUpdateCase = async (req: Request, res: Response) => {
	try {
		const c: any = await SupportCaseModel.findById(req.params.id).maxTimeMS(time).lean().exec();
		if (!c) return res.status(404).json({ message: "Case not found." });
		if (req.body.expectedVersion !== undefined && req.body.expectedVersion !== c.version)
			return res.status(409).json({ message: "This case changed meanwhile. Reload it.", code: "case_changed" });
		const set: Record<string, unknown> = {};
		const before: Record<string, unknown> = {};
		const after: Record<string, unknown> = {};
		const change = (field: string, from: unknown, to: unknown) => {
			before[field] = from;
			after[field] = to;
		};
		if (req.body.status !== undefined && req.body.status !== c.status) {
			const allowed = canChangeStatus(c.status, req.body.status);
			if (!allowed.ok) return res.status(409).json({ message: allowed.message });
			set.status = req.body.status;
			if (req.body.status === "open") set.resolution = null;
			change("status", c.status, req.body.status);
		}
		if (req.body.priority !== undefined && req.body.priority !== c.priority) {
			set.priority = req.body.priority;
			change("priority", c.priority, req.body.priority);
		}
		if (req.body.category !== undefined && req.body.category !== c.category) {
			set.category = req.body.category;
			change("category", c.category, req.body.category);
		}
		if (req.body.assigneeId !== undefined && String(req.body.assigneeId) !== String(c.assignee?.id ?? null)) {
			const assignee = await findAdmin(req.body.assigneeId);
			if (assignee === undefined)
				return res
					.status(400)
					.json({ message: "The assignee must be an active admin who can work cases.", field: "assigneeId" });
			set.assignee = assignee;
			change("assignee", c.assignee?.email ?? null, assignee?.email ?? null);
		}
		if (!Object.keys(set).length) return res.status(409).json({ message: "Nothing to change." });
		set.lastActivityAt = new Date();
		const updated = await SupportCaseModel.findOneAndUpdate(
			{ _id: c._id, version: c.version },
			{ $set: set, $inc: { version: 1 } },
			{ new: true },
		)
			.lean()
			.exec();
		if (!updated)
			return res.status(409).json({ message: "This case changed meanwhile. Reload it.", code: "case_changed" });
		await auditCase(req, "support.case_updated", c, { before, after, reason: req.body.reason ?? null });
		emitEvent(
			{
				type: "support.case_updated",
				actor: { type: "admin", id: req.admin!._id },
				subjects: subjectsOf(c),
				properties: { caseId: String(c._id), changes: Object.keys(after), status: updated.status },
			},
			req,
		);
		res.json(await caseDetail(req, updated));
	} catch (error) {
		answerError(res, error, "updating case");
	}
};

/** POST /admin/cases/:id/notes { body } */
export const handleAddCaseNote = async (req: Request, res: Response) => {
	try {
		const note = {
			_id: new mongoose.Types.ObjectId(),
			body: String(req.body.body).trim(),
			author: by(req),
			at: new Date(),
		};
		const updated = await SupportCaseModel.findOneAndUpdate(
			{ _id: req.params.id },
			{ $push: { notes: note }, $set: { lastActivityAt: note.at }, $inc: { version: 1 } },
			{ new: true },
		)
			.lean()
			.exec();
		if (!updated) return res.status(404).json({ message: "Case not found." });
		await auditCase(req, "support.case_note_added", updated, {
			after: { noteId: String(note._id), body: note.body },
		});
		emitEvent(
			{
				type: "support.case_updated",
				actor: { type: "admin", id: req.admin!._id },
				subjects: subjectsOf(updated),
				properties: { caseId: String(updated._id), changes: ["notes"], status: updated.status },
			},
			req,
		);
		res.status(201).json(await caseDetail(req, updated));
	} catch (error) {
		answerError(res, error, "adding a case note");
	}
};

/**
 * POST /admin/cases/:id/messages { to: "customer" | "provider", subject, body, idempotencyKey }
 * Emails the party through the outbound email module (its policy applies: blocked and demo addresses are skipped and
 * recorded as such). The same idempotencyKey again returns the recorded message without sending twice.
 */
export const handleSendCaseMessage = async (req: Request, res: Response) => {
	try {
		const c: any = await SupportCaseModel.findById(req.params.id).maxTimeMS(time).lean().exec();
		if (!c) return res.status(404).json({ message: "Case not found." });
		const key = String(req.body.idempotencyKey);
		const previous = (c.messages ?? []).find((m: any) => m.idempotencyKey === key);
		if (previous) return res.json({ replayed: true, message: { ...previous, _id: String(previous._id) } });
		const party = (c.parties ?? []).find((p: any) => p.role === req.body.to);
		if (!party) return res.status(409).json({ message: `This case has no ${req.body.to}.` });
		const user: any = await UserModel.findById(party.userId, "email firstName suspended").lean().exec();
		if (!user) return res.status(404).json({ message: "The recipient's account no longer exists." });

		// Reserve the key first so a double click cannot send twice.
		const messageId = new mongoose.Types.ObjectId();
		const subject = caseMessageSubject(c.reference, String(req.body.subject).trim());
		const body = String(req.body.body).trim();
		const reserved = await SupportCaseModel.updateOne(
			{ _id: c._id, "messages.idempotencyKey": { $ne: key } },
			{
				$push: {
					messages: {
						_id: messageId,
						to: req.body.to,
						userId: party.userId,
						subject,
						body,
						channel: "email",
						result: "failed",
						skippedBecause: "sending",
						idempotencyKey: key,
						by: by(req),
						at: new Date(),
					},
				},
			},
		);
		if (reserved.modifiedCount === 0)
			return res
				.status(409)
				.json({ message: "This message is already being sent.", code: "message_in_progress" });

		const result = await sendEmail({
			template: "support-message",
			from: `HelpHive support <${SUPPORT_EMAIL}>`,
			to: user.email,
			subject,
			react: PlainMessageEmail({
				heading: `Hello ${user.firstName ?? ""}`.trim(),
				body,
				footer: `HelpHive support, case ${c.reference}. Reply to this email to answer.`,
			}),
			userId: String(user._id),
		});
		const outcome = result.status;
		const skippedBecause = result.status === "skipped" ? result.reason : null;
		await SupportCaseModel.updateOne(
			{ _id: c._id, "messages._id": messageId },
			{
				$set: {
					"messages.$.result": outcome,
					"messages.$.skippedBecause": skippedBecause,
					"messages.$.messageId": result.status === "sent" ? result.messageId : null,
					lastActivityAt: new Date(),
				},
				$inc: { version: 1 },
			},
		);
		await auditCase(req, "support.case_message_sent", c, {
			outcome: outcome === "failed" ? "failure" : "success",
			after: { to: req.body.to, subject, body, result: outcome, skippedBecause },
		});
		emitEvent(
			{
				type: "support.case_message_sent",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { userId: party.userId, bookingId: c.bookingId },
				properties: { caseId: String(c._id), to: req.body.to, result: outcome },
			},
			req,
		);
		const updated = await SupportCaseModel.findById(c._id).lean().exec();
		res.status(outcome === "failed" ? 502 : 201).json({
			replayed: false,
			result: outcome,
			skippedBecause,
			...(outcome === "failed"
				? { message: "The email provider refused the message. Try again with a new message." }
				: {}),
			...(await caseDetail(req, updated)),
		});
	} catch (error) {
		answerError(res, error, "sending a case message");
	}
};

const ACTION_TARGETS: Record<string, mongoose.Model<any>> = {
	payment: PaymentModel,
	booking: BookingModel,
	user: UserModel,
};

/** POST /admin/cases/:id/actions { kind, targetType: payment|booking|user, targetId, summary } */
export const handleLinkCaseAction = async (req: Request, res: Response) => {
	try {
		const model = ACTION_TARGETS[req.body.targetType];
		if (!(await model.exists({ _id: oid(req.body.targetId) })))
			return res.status(404).json({ message: `That ${req.body.targetType} was not found.` });
		const action = {
			_id: new mongoose.Types.ObjectId(),
			kind: req.body.kind,
			targetType: req.body.targetType,
			targetId: String(req.body.targetId),
			summary: String(req.body.summary).trim(),
			by: by(req),
			at: new Date(),
		};
		const updated = await SupportCaseModel.findOneAndUpdate(
			{ _id: req.params.id },
			{ $push: { actions: action }, $set: { lastActivityAt: action.at }, $inc: { version: 1 } },
			{ new: true },
		)
			.lean()
			.exec();
		if (!updated) return res.status(404).json({ message: "Case not found." });
		await auditCase(req, "support.case_action_linked", updated, {
			after: {
				kind: action.kind,
				targetType: action.targetType,
				targetId: action.targetId,
				summary: action.summary,
			},
		});
		emitEvent(
			{
				type: "support.case_updated",
				actor: { type: "admin", id: req.admin!._id },
				subjects: subjectsOf(updated),
				properties: { caseId: String(updated._id), changes: ["actions"], status: updated.status },
			},
			req,
		);
		res.status(201).json(await caseDetail(req, updated));
	} catch (error) {
		answerError(res, error, "linking an action");
	}
};

/** POST /admin/cases/:id/resolve { outcome, summary } */
export const handleResolveCase = async (req: Request, res: Response) => {
	try {
		const c: any = await SupportCaseModel.findById(req.params.id).maxTimeMS(time).lean().exec();
		if (!c) return res.status(404).json({ message: "Case not found." });
		if (!OPEN_STATUSES.has(c.status)) return res.status(409).json({ message: "The case is not open." });
		const resolution = {
			outcome: req.body.outcome,
			summary: String(req.body.summary).trim(),
			at: new Date(),
			by: by(req),
		};
		const updated = await SupportCaseModel.findOneAndUpdate(
			{ _id: c._id, version: c.version },
			{ $set: { status: "resolved", resolution, lastActivityAt: resolution.at }, $inc: { version: 1 } },
			{ new: true },
		)
			.lean()
			.exec();
		if (!updated)
			return res.status(409).json({ message: "This case changed meanwhile. Reload it.", code: "case_changed" });
		await auditCase(req, "support.case_resolved", c, {
			before: { status: c.status },
			after: { status: "resolved", outcome: resolution.outcome, summary: resolution.summary },
		});
		emitEvent(
			{
				type: "support.case_resolved",
				actor: { type: "admin", id: req.admin!._id },
				subjects: subjectsOf(c),
				properties: {
					caseId: String(c._id),
					outcome: resolution.outcome,
					openForMs: resolution.at.getTime() - new Date(c.createdAt).getTime(),
				},
			},
			req,
		);
		res.json(await caseDetail(req, updated));
	} catch (error) {
		answerError(res, error, "resolving case");
	}
};
