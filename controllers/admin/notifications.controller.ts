// Notifications centre: preview an announcement for a segment (audience size, exclusions and rendered samples), send
// it by push (OneSignal, the existing provider) and/or email (the outbound email module and its policy), keep the
// history, and manage templates. Sends are idempotent per key, rate limited, recorded and audited.
import type { Request, Response } from "express";
import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import { NotificationCampaignModel, NotificationTemplateModel } from "../../dal/models/notificationCampaign.model";
import { sendNotification } from "../service-accounts/onesignal";
import { sendEmail } from "../../lib/email";
import { checkRecipientDefault } from "../../lib/emailPolicy";
import { SUPPORT_EMAIL } from "../../config/config";
import { PlainMessageEmail } from "../../emails/plainMessageEmail";
import {
	CHANNELS,
	MAX_EMAIL_RECIPIENTS,
	MAX_PUSH_RECIPIENTS,
	PLACEHOLDERS,
	bookedInRangeQuery,
	decideSend,
	emailExclusion,
	parseSegment,
	pushBatches,
	recipientExclusion,
	renderMessage,
	segmentUserFilter,
	sendFingerprint,
	validateTemplate,
	type Channel,
	type MessageTemplate,
	type Recipient,
	type Segment,
} from "../../lib/notifications";
import { parseListQuery, runListQuery, ListQueryError, type ListSpec } from "../../lib/listQuery";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import log from "../../lib/logger";
import { DETAIL_TIME_LIMIT_MS, answerError, oid } from "./operations.shared";

const supportEmail = SUPPORT_EMAIL || "support@helphive.himaiz.com";

const parseChannels = (value: unknown): Channel[] | null => {
	const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const channels = [...new Set(list.map((c) => String(c).trim()).filter(Boolean))];
	return channels.length && channels.every((c) => (CHANNELS as readonly string[]).includes(c))
		? (channels as Channel[])
		: null;
};

const toRecipient = (u: any): Recipient => ({
	_id: String(u._id),
	email: u.email,
	firstName: u.firstName,
	lastName: u.lastName,
	isProvider: !!u.roles?.Provider,
	suspended: !!u.suspended,
	isEmailVerified: !!u.isEmailVerified,
});

/** The people a segment matches (suspended accounts already left out), at most MAX_PUSH_RECIPIENTS + 1. */
const resolveAudience = async (segment: Segment) => {
	let bookedIds: string[] | undefined;
	if (segment.type === "booked_in_range") {
		const { filter, fields } = bookedInRangeQuery(segment);
		const ids = await Promise.all(
			fields.map((field) =>
				BookingModel.distinct(field, { ...filter, [field]: { $ne: null } })
					.maxTimeMS(DETAIL_TIME_LIMIT_MS)
					.exec(),
			),
		);
		bookedIds = [...new Set(ids.flat().map(String))];
	}
	const filter = segmentUserFilter(segment, bookedIds) as Record<string, any>;
	if (filter._id && typeof filter._id === "string") filter._id = oid(filter._id);
	if (filter._id?.$in) filter._id = { $in: filter._id.$in.map(oid) };
	const [users, suspended] = await Promise.all([
		UserModel.find(filter, "email firstName lastName roles suspended isEmailVerified")
			.limit(MAX_PUSH_RECIPIENTS + 1)
			.maxTimeMS(DETAIL_TIME_LIMIT_MS * 2)
			.lean()
			.exec(),
		UserModel.countDocuments({ ...filter, suspended: true })
			.maxTimeMS(DETAIL_TIME_LIMIT_MS)
			.exec(),
	]);
	return { recipients: users.map(toRecipient), suspended };
};

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				out[index] = await fn(items[index]);
			}
		}),
	);
	return out;
};

/** Who each channel would reach, and who is left out and why. Email addresses are checked against the email policy. */
const planAudience = async (segment: Segment, channels: Channel[]) => {
	const { recipients, suspended } = await resolveAudience(segment);
	const tooMany = recipients.length > MAX_PUSH_RECIPIENTS;
	const people = recipients.slice(0, MAX_PUSH_RECIPIENTS);
	const excluded: Record<string, number> = { suspended };
	const push: Recipient[] = [];
	const emailCandidates: Recipient[] = [];
	for (const r of people) {
		const reason = recipientExclusion(r);
		if (reason) {
			excluded[reason] = (excluded[reason] ?? 0) + 1;
			continue;
		}
		if (channels.includes("push")) push.push(r);
		if (channels.includes("email")) {
			const emailReason = emailExclusion(r);
			if (emailReason) excluded[`email_${emailReason}`] = (excluded[`email_${emailReason}`] ?? 0) + 1;
			else emailCandidates.push(r);
		}
	}
	const emailTooMany = emailCandidates.length > MAX_EMAIL_RECIPIENTS;
	const email: Recipient[] = [];
	if (channels.includes("email") && !emailTooMany) {
		const decisions = await mapLimit(emailCandidates, 10, (r) => checkRecipientDefault(r.email));
		decisions.forEach((d, i) => {
			if (d.allowed) email.push(emailCandidates[i]);
			else excluded[`email_${d.reason}`] = (excluded[`email_${d.reason}`] ?? 0) + 1;
		});
	}
	const problems: string[] = [];
	if (tooMany) problems.push(`This audience is larger than ${MAX_PUSH_RECIPIENTS} people. Narrow it.`);
	if (emailTooMany)
		problems.push(
			`Email reaches at most ${MAX_EMAIL_RECIPIENTS} people per send (the email provider's rate limit); this audience has ${emailCandidates.length}. Send by push, or narrow the audience.`,
		);
	return {
		matched: people.length + suspended,
		push,
		email,
		excluded,
		problems,
		reachable: new Set([...push, ...email].map((r) => r._id)).size,
	};
};

const audienceSummary = (plan: Awaited<ReturnType<typeof planAudience>>) => ({
	matched: plan.matched,
	reachable: plan.reachable,
	push: plan.push.length,
	email: plan.email.length,
	excluded: plan.excluded,
	problems: plan.problems,
});

const readRequest = (source: Record<string, unknown>) => {
	const segmentSource =
		typeof source.segment === "object" && source.segment
			? source.segment
			: {
					type: source.type,
					serviceId: source.serviceId,
					from: source.from,
					to: source.to,
					party: source.party,
					userId: source.userId,
					approvedOnly: source.approvedOnly === "false" ? false : source.approvedOnly,
				};
	const segment = parseSegment(segmentSource);
	if (!segment.ok) return { ok: false as const, message: segment.message, field: "segment" };
	const channels = parseChannels(source.channels);
	if (!channels) return { ok: false as const, message: "channels must be push, email or both.", field: "channels" };
	const templateSource =
		typeof source.template === "object" && source.template
			? source.template
			: { title: source.title, body: source.body, emailSubject: source.emailSubject };
	const template = validateTemplate(templateSource, channels);
	if (!template.ok) return { ok: false as const, message: template.message, field: "template" };
	return { ok: true as const, segment: segment.segment, channels, template: template.template };
};

/** GET /admin/notifications/preview?type=&serviceId=&from=&to=&party=&userId=&approvedOnly=&channels=&title=&body=&emailSubject= */
export const handlePreview = async (req: Request, res: Response) => {
	try {
		for (const [key, value] of Object.entries(req.query))
			if (typeof value !== "string") throw new ListQueryError(`${key} must be given once, as text.`, key);
		const parsed = readRequest(req.query as Record<string, unknown>);
		if (!parsed.ok) return res.status(400).json({ message: parsed.message, field: parsed.field });
		const plan = await planAudience(parsed.segment, parsed.channels);
		const samples = [...plan.push, ...plan.email]
			.filter((r, i, all) => all.findIndex((x) => x._id === r._id) === i)
			.slice(0, 3)
			.map((r) => ({
				recipient: { firstName: r.firstName, role: r.isProvider ? "provider" : "customer" },
				...renderMessage(parsed.template, r, supportEmail),
			}));
		res.json({
			segment: parsed.segment,
			channels: parsed.channels,
			audience: audienceSummary(plan),
			samples,
			placeholders: PLACEHOLDERS,
			limits: { push: MAX_PUSH_RECIPIENTS, email: MAX_EMAIL_RECIPIENTS },
		});
	} catch (error) {
		answerError(res, error, "previewing an announcement");
	}
};

/**
 * POST /admin/notifications/send { segment, channels, template, templateId?, idempotencyKey, confirmReachable }
 * `confirmReachable` is the `reachable` count the preview showed: if the audience changed meanwhile, nothing is sent
 * (409 audience_changed with the new numbers). The same idempotencyKey again returns the first send's record.
 */
export const handleSend = async (req: Request, res: Response) => {
	try {
		const parsed = readRequest(req.body ?? {});
		if (!parsed.ok) return res.status(400).json({ message: parsed.message, field: parsed.field });
		const key = String(req.body.idempotencyKey);
		const fingerprint = sendFingerprint(parsed);
		const existing = await NotificationCampaignModel.findOne({ idempotencyKey: key }).lean().exec();
		const decision = decideSend(existing, fingerprint);
		if (decision === "replay") return res.json({ replayed: true, campaign: publicCampaign(existing) });
		if (decision === "in_progress")
			return res.status(409).json({ message: "This announcement is being sent.", code: "send_in_progress" });
		if (decision === "key_reused")
			return res.status(409).json({
				message: "This key was used for a different announcement. Start a new send.",
				code: "key_reused",
			});

		const plan = await planAudience(parsed.segment, parsed.channels);
		if (plan.problems.length)
			return res.status(400).json({ message: plan.problems.join(" "), audience: audienceSummary(plan) });
		if (plan.reachable === 0)
			return res
				.status(400)
				.json({ message: "Nobody in this audience can be reached.", audience: audienceSummary(plan) });
		if (Number(req.body.confirmReachable) !== plan.reachable) {
			return res.status(409).json({
				message: `The audience changed: it now reaches ${plan.reachable} people. Check the preview and send again.`,
				code: "audience_changed",
				audience: audienceSummary(plan),
			});
		}
		const startedAt = new Date();
		let campaign;
		try {
			campaign = await NotificationCampaignModel.create({
				idempotencyKey: key,
				fingerprint,
				status: "sending",
				segment: parsed.segment,
				channels: parsed.channels,
				template: parsed.template,
				templateId:
					typeof req.body.templateId === "string" && /^[a-f\d]{24}$/i.test(req.body.templateId)
						? req.body.templateId
						: null,
				by: { id: req.admin!._id, email: req.admin!.email },
				audience: audienceSummary(plan),
				results: {},
				startedAt,
			});
		} catch (error: any) {
			if (error?.code === 11000)
				return res.status(409).json({ message: "This announcement is being sent.", code: "send_in_progress" });
			throw error;
		}

		const results = await deliver(parsed.template, plan.push, plan.email);
		const failedAll =
			results.push.failed + results.email.failed > 0 && results.push.sent + results.email.sent === 0;
		const status = failedAll ? "failed" : results.push.failed + results.email.failed > 0 ? "partial" : "sent";
		const finishedAt = new Date();
		await NotificationCampaignModel.updateOne({ _id: campaign._id }, { $set: { status, results, finishedAt } });
		await recordAudit(
			{
				action: "notifications.sent",
				outcome: status === "failed" ? "failure" : "success",
				actor: adminActor(req),
				target: { type: "notificationCampaign", id: String(campaign._id) },
				after: {
					segment: parsed.segment,
					channels: parsed.channels,
					title: parsed.template.title,
					body: parsed.template.body,
					audience: audienceSummary(plan),
					results,
				},
			},
			req,
		);
		emitEvent(
			{
				type: "notification.campaign_sent",
				actor: { type: "admin", id: req.admin!._id },
				subjects: parsed.segment.type === "one_person" ? { userId: parsed.segment.userId } : {},
				properties: {
					campaignId: String(campaign._id),
					segment: parsed.segment.type,
					channels: parsed.channels,
					targeted: plan.reachable,
					pushSent: results.push.sent,
					emailSent: results.email.sent,
					emailSkipped: results.email.skipped,
				},
			},
			req,
		);
		const saved = await NotificationCampaignModel.findById(campaign._id).lean().exec();
		res.status(status === "failed" ? 502 : 201).json({ replayed: false, campaign: publicCampaign(saved) });
	} catch (error) {
		answerError(res, error, "sending an announcement");
	}
};

/** Push in batches (one request per rendered text, up to 2000 people each), then email one by one (two at a time). */
const deliver = async (template: MessageTemplate, push: Recipient[], email: Recipient[]) => {
	const results = {
		push: { targeted: push.length, sent: 0, failed: 0, requests: 0 },
		email: { targeted: email.length, sent: 0, skipped: 0, failed: 0, skippedBecause: {} as Record<string, number> },
	};
	for (const batch of pushBatches(template, push, supportEmail)) {
		results.push.requests++;
		const response = await sendNotification({
			include_aliases: { external_id: batch.ids },
			headings: { en: batch.title },
			contents: { en: batch.body },
			data: { type: "announcement" },
		});
		if (response) results.push.sent += batch.ids.length;
		else results.push.failed += batch.ids.length;
	}
	await mapLimit(email, 2, async (r) => {
		const message = renderMessage(template, r, supportEmail);
		const result = await sendEmail({
			template: "announcement",
			from: `HelpHive <${supportEmail}>`,
			to: r.email ?? "",
			subject: message.emailSubject,
			react: PlainMessageEmail({
				heading: message.title,
				body: message.body,
				footer: `Questions? Write to ${supportEmail}.`,
			}),
			userId: r._id,
		});
		if (result.status === "sent") results.email.sent++;
		else if (result.status === "skipped") {
			results.email.skipped++;
			results.email.skippedBecause[result.reason] = (results.email.skippedBecause[result.reason] ?? 0) + 1;
		} else {
			results.email.failed++;
			log.warn("announcement_email_failed", "Announcement email failed", { userId: r._id });
		}
	});
	return results;
};

const publicCampaign = (c: any) =>
	c && {
		_id: String(c._id),
		status: c.status,
		segment: c.segment,
		channels: c.channels,
		template: c.template,
		templateId: c.templateId ? String(c.templateId) : null,
		by: c.by,
		audience: c.audience,
		results: c.results,
		startedAt: c.startedAt,
		finishedAt: c.finishedAt,
	};

const CAMPAIGN_LIST_SPEC: ListSpec = {
	sortable: { startedAt: "startedAt" },
	defaultSort: "-startedAt",
	filters: { status: { type: "enum", path: "status", values: ["sending", "sent", "partial", "failed"] } },
	dateField: "startedAt",
	maxPageSize: 100,
};

/** GET /admin/notifications/campaigns */
export const handleListCampaigns = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query as Record<string, unknown>, CAMPAIGN_LIST_SPEC);
		res.json(await runListQuery(NotificationCampaignModel, parsed, { map: publicCampaign }));
	} catch (error) {
		answerError(res, error, "listing announcements");
	}
};

/** GET /admin/notifications/campaigns/:id */
export const handleGetCampaign = async (req: Request, res: Response) => {
	try {
		const c = await NotificationCampaignModel.findById(req.params.id).maxTimeMS(DETAIL_TIME_LIMIT_MS).lean().exec();
		if (!c) return res.status(404).json({ message: "Announcement not found." });
		res.json({ campaign: publicCampaign(c) });
	} catch (error) {
		answerError(res, error, "getting an announcement");
	}
};

// --- Templates -------------------------------------------------------------------------------------------------

const publicTemplate = (t: any) => ({
	_id: String(t._id),
	name: t.name,
	title: t.title,
	body: t.body,
	emailSubject: t.emailSubject ?? null,
	updatedBy: t.updatedBy,
	updatedAt: t.updatedAt,
});

/** GET /admin/notifications/templates */
export const handleListTemplates = async (_req: Request, res: Response) => {
	try {
		const items = await NotificationTemplateModel.find({ deletedAt: null })
			.sort({ name: 1 })
			.limit(200)
			.lean()
			.exec();
		res.json({ items: items.map(publicTemplate), placeholders: PLACEHOLDERS });
	} catch (error) {
		answerError(res, error, "listing templates");
	}
};

const readTemplateBody = (body: any) => {
	const name = typeof body?.name === "string" ? body.name.trim() : "";
	if (!name || name.length > 80) return { ok: false as const, message: "Name the template (1 to 80 characters)." };
	const template = validateTemplate(body, ["push"]);
	if (!template.ok) return template;
	return { ok: true as const, name, template: template.template };
};

/** POST /admin/notifications/templates { name, title, body, emailSubject? } */
export const handleCreateTemplate = async (req: Request, res: Response) => {
	try {
		const parsed = readTemplateBody(req.body);
		if (!parsed.ok) return res.status(400).json({ message: parsed.message });
		const t = await NotificationTemplateModel.create({
			name: parsed.name,
			...parsed.template,
			updatedBy: { id: req.admin!._id, email: req.admin!.email },
		});
		await recordAudit(
			{
				action: "notifications.template_saved",
				actor: adminActor(req),
				target: { type: "notificationTemplate", id: String(t._id) },
				after: publicTemplate(t),
			},
			req,
		);
		emitEvent(
			{
				type: "admin.action_taken",
				actor: { type: "admin", id: req.admin!._id },
				properties: { action: "notifications.template_saved", targetType: "notificationTemplate" },
			},
			req,
		);
		res.status(201).json({ template: publicTemplate(t) });
	} catch (error) {
		answerError(res, error, "creating a template");
	}
};

/** PATCH /admin/notifications/templates/:id { name, title, body, emailSubject? } */
export const handleUpdateTemplate = async (req: Request, res: Response) => {
	try {
		const parsed = readTemplateBody(req.body);
		if (!parsed.ok) return res.status(400).json({ message: parsed.message });
		const before = await NotificationTemplateModel.findOne({ _id: req.params.id, deletedAt: null }).lean().exec();
		if (!before) return res.status(404).json({ message: "Template not found." });
		const t = await NotificationTemplateModel.findOneAndUpdate(
			{ _id: req.params.id, deletedAt: null },
			{
				$set: {
					name: parsed.name,
					...parsed.template,
					updatedBy: { id: req.admin!._id, email: req.admin!.email },
				},
			},
			{ new: true },
		)
			.lean()
			.exec();
		await recordAudit(
			{
				action: "notifications.template_saved",
				actor: adminActor(req),
				target: { type: "notificationTemplate", id: String(before._id) },
				before: publicTemplate(before),
				after: publicTemplate(t),
			},
			req,
		);
		emitEvent(
			{
				type: "admin.action_taken",
				actor: { type: "admin", id: req.admin!._id },
				properties: { action: "notifications.template_saved", targetType: "notificationTemplate" },
			},
			req,
		);
		res.json({ template: publicTemplate(t) });
	} catch (error) {
		answerError(res, error, "updating a template");
	}
};

/** DELETE /admin/notifications/templates/:id (kept, marked deleted) */
export const handleDeleteTemplate = async (req: Request, res: Response) => {
	try {
		const t = await NotificationTemplateModel.findOneAndUpdate(
			{ _id: req.params.id, deletedAt: null },
			{ $set: { deletedAt: new Date() } },
			{ new: false },
		)
			.lean()
			.exec();
		if (!t) return res.status(404).json({ message: "Template not found." });
		await recordAudit(
			{
				action: "notifications.template_deleted",
				actor: adminActor(req),
				target: { type: "notificationTemplate", id: String(t._id) },
				before: publicTemplate(t),
			},
			req,
		);
		emitEvent(
			{
				type: "admin.action_taken",
				actor: { type: "admin", id: req.admin!._id },
				properties: { action: "notifications.template_deleted", targetType: "notificationTemplate" },
			},
			req,
		);
		res.status(204).end();
	} catch (error) {
		answerError(res, error, "deleting a template");
	}
};
