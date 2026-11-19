// Fraud and risk (risk.read to see, risk.manage to act): overview, signals, rules and backtests, explained scores,
// linked accounts, review cases and their actions, payout holds, block and allow lists. Every write is audited and
// emits an event; the admin router masks every response for the demo admin.
import type { Request, Response } from "express";
import mongoose from "mongoose";
import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import PayoutModel from "../../dal/models/payout.model";
import EventModel from "../../dal/models/event.model";
import AdminModel from "../../dal/models/admin.model";
import {
	CASE_STATUSES,
	CASE_SUBJECT_TYPES,
	HOLD_KINDS,
	RiskCaseModel,
	RiskHitModel,
	RiskHoldModel,
	RiskListModel,
	RiskRuleModel,
	RiskScoreModel,
	type CaseSubjectType,
	type HoldKind,
} from "../../dal/models/risk.model";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import { parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import { isDemoAdmin } from "../../config/adminPermissions";
import { maskForDemo } from "../../lib/demoMask";
import { bookingReference, roundMoney } from "../../lib/operations";
import { computeSignals, indexDataset, signalCatalogue, SIGNAL_BY_KEY } from "../../lib/risk/signals";
import {
	DEFAULT_RULES,
	RULE_ACTION_LABELS,
	RuleValidationError,
	evaluateRule,
	explainScore,
	validateRule,
	type RuleDefinition,
	type RuleHit,
} from "../../lib/risk/rules";
import { runBacktest } from "../../lib/risk/backtest";
import { buildLinkGraph, clampLimits } from "../../lib/risk/graph";
import { LIST_KIND_LABELS, normalizeListValue, type ListKind, type ListType } from "../../lib/risk/lists";
import { invalidateLists } from "../../lib/risk/gate";
import { placeHold, releaseHold } from "../../lib/risk/holds";
import {
	activeRules,
	invalidateRules,
	loadLinks,
	loadPeriodDataset,
	loadUserDataset,
	openOrUpdateCase,
	ruleFromDocument,
} from "../../lib/risk/engine";
import { handleReinstateUser, handleSuspendUser } from "./users.controller";
import { handleRefundPayment } from "./payments.controller";
import {
	DETAIL_TIME_LIMIT_MS,
	answerError,
	auditFor,
	can,
	loadPeople,
	oid,
	publicEvent,
	takeParams,
} from "./operations.shared";

const DAY = 24 * 60 * 60 * 1000;

const by = (req: Request) => ({ type: "admin", id: String(req.admin!._id), email: req.admin!.email });
const adminRef = (req: Request) => ({ id: req.admin!._id, email: req.admin!.email });

const forbidden = (res: Response, permission: string) =>
	res.status(403).json({ message: `This also needs the ${permission} permission.`, permission });

// --- Overview ----------------------------------------------------------------------------------------------------

const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const daysBetween = (from: number, to: number) => {
	const days: string[] = [];
	for (let t = Date.parse(`${dayKey(new Date(from))}T00:00:00Z`); t <= to; t += DAY) days.push(dayKey(new Date(t)));
	return days;
};

/** GET /admin/risk/overview?days=30 */
export const handleRiskOverview = async (req: Request, res: Response) => {
	try {
		const days = Math.min(90, Math.max(7, Number.parseInt(String(req.query.days ?? "30"), 10) || 30));
		const now = Date.now();
		const from = new Date(now - days * DAY);
		const half = new Date(now - 7 * DAY);
		const before = new Date(now - 14 * DAY);
		const limit = { maxTimeMS: DETAIL_TIME_LIMIT_MS };
		const [openCases, scoreBands, hitsByDay, topRules, holds, blockedByDay, heldByType, recentCases, rules, trend] =
			await Promise.all([
				RiskCaseModel.aggregate([
					{ $match: { active: true } },
					{
						$project: {
							severity: 1,
							ageDays: { $divide: [{ $subtract: [new Date(now), "$createdAt"] }, DAY] },
						},
					},
					{
						$group: {
							_id: "$severity",
							count: { $sum: 1 },
							under1d: { $sum: { $cond: [{ $lt: ["$ageDays", 1] }, 1, 0] } },
							d1to3: {
								$sum: {
									$cond: [{ $and: [{ $gte: ["$ageDays", 1] }, { $lt: ["$ageDays", 3] }] }, 1, 0],
								},
							},
							d3to7: {
								$sum: {
									$cond: [{ $and: [{ $gte: ["$ageDays", 3] }, { $lt: ["$ageDays", 7] }] }, 1, 0],
								},
							},
							over7d: { $sum: { $cond: [{ $gte: ["$ageDays", 7] }, 1, 0] } },
							oldest: { $min: "$createdAt" },
						},
					},
				]).option(limit),
				RiskScoreModel.aggregate([
					{
						$group: {
							_id: { $min: [90, { $multiply: [{ $floor: { $divide: ["$score", 10] } }, 10] }] },
							count: { $sum: 1 },
						},
					},
					{ $sort: { _id: 1 } },
				]).option(limit),
				RiskHitModel.aggregate([
					{ $match: { at: { $gte: from } } },
					{
						$group: {
							_id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$at" } }, mode: "$mode" },
							count: { $sum: 1 },
						},
					},
				]).option(limit),
				RiskHitModel.aggregate([
					{ $match: { at: { $gte: from } } },
					{
						$group: {
							_id: "$ruleKey",
							count: { $sum: 1 },
							people: { $addToSet: "$userId" },
							last: { $max: "$at" },
						},
					},
					{ $project: { count: 1, people: { $size: "$people" }, last: 1 } },
					{ $sort: { count: -1 } },
					{ $limit: 10 },
				]).option(limit),
				RiskHoldModel.aggregate([
					{ $match: { active: true } },
					{ $group: { _id: "$kind", count: { $sum: 1 }, oldest: { $min: "$createdAt" } } },
				]).option(limit),
				EventModel.aggregate([
					{ $match: { type: "risk.attempt_blocked", at: { $gte: from } } },
					{
						$group: {
							_id: {
								day: { $dateToString: { format: "%Y-%m-%d", date: "$at" } },
								point: "$properties.point",
							},
							count: { $sum: 1 },
						},
					},
				]).option(limit),
				EventModel.aggregate([
					{ $match: { type: { $in: ["payout.held", "earning.held"] }, at: { $gte: from } } },
					{ $group: { _id: "$type", count: { $sum: 1 }, amount: { $sum: "$properties.amount" } } },
				]).option(limit),
				RiskCaseModel.find({ active: true }, "title severity score status subject userId createdAt assignee")
					.sort({ createdAt: -1 })
					.limit(8)
					.maxTimeMS(DETAIL_TIME_LIMIT_MS)
					.lean()
					.exec(),
				RiskRuleModel.find({}, "key title mode").lean().exec(),
				Promise.all([
					RiskHitModel.countDocuments({ at: { $gte: half } }),
					RiskHitModel.countDocuments({ at: { $gte: before, $lt: half } }),
					RiskCaseModel.countDocuments({ createdAt: { $gte: half } }),
					RiskCaseModel.countDocuments({ createdAt: { $gte: before, $lt: half } }),
					EventModel.countDocuments({ type: "risk.attempt_blocked", at: { $gte: half } }),
					EventModel.countDocuments({ type: "risk.attempt_blocked", at: { $gte: before, $lt: half } }),
				]),
			]);
		const dayList = daysBetween(from.getTime(), now);
		const series = (rows: any[], field: string, value: string) =>
			dayList.map((day) =>
				rows.filter((r) => r._id.day === day && r._id[field] === value).reduce((s, r) => s + r.count, 0),
			);
		const titles = new Map(rules.map((r: any) => [r.key, r]));
		const people = await loadPeople(recentCases.map((c: any) => c.userId));
		res.json({
			generatedAt: new Date(now).toISOString(),
			days,
			openCases: {
				total: openCases.reduce((s: number, r: any) => s + r.count, 0),
				bySeverity: Object.fromEntries(
					["critical", "high", "medium", "low"].map((sev) => {
						const row: any = openCases.find((r: any) => r._id === sev) ?? {};
						return [
							sev,
							{
								count: row.count ?? 0,
								ages: {
									under1d: row.under1d ?? 0,
									d1to3: row.d1to3 ?? 0,
									d3to7: row.d3to7 ?? 0,
									over7d: row.over7d ?? 0,
								},
								oldest: row.oldest ?? null,
							},
						];
					}),
				),
				recent: recentCases.map((c: any) => caseListItem(c, people)),
			},
			scores: {
				evaluated: scoreBands.reduce((s: number, r: any) => s + r.count, 0),
				histogram: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map((lower) => ({
					from: lower,
					to: lower === 90 ? 100 : lower + 9,
					count: scoreBands.find((r: any) => r._id === lower)?.count ?? 0,
				})),
			},
			firing: {
				days: dayList,
				enforce: series(hitsByDay, "mode", "enforce"),
				observe: series(hitsByDay, "mode", "observe"),
				topRules: topRules.map((r: any) => ({
					ruleKey: r._id,
					title: (titles.get(r._id) as any)?.title ?? r._id,
					mode: (titles.get(r._id) as any)?.mode ?? null,
					hits: r.count,
					people: r.people,
					lastFiredAt: r.last,
				})),
			},
			holds: {
				total: holds.reduce((s: number, r: any) => s + r.count, 0),
				byKind: Object.fromEntries(HOLD_KINDS.map((k) => [k, holds.find((r: any) => r._id === k)?.count ?? 0])),
				oldest: holds.reduce((o: Date | null, r: any) => (!o || r.oldest < o ? r.oldest : o), null),
				stopped: {
					payouts: heldByType.find((r: any) => r._id === "payout.held")?.count ?? 0,
					payoutAmount: roundMoney(heldByType.find((r: any) => r._id === "payout.held")?.amount ?? 0),
					earnings: heldByType.find((r: any) => r._id === "earning.held")?.count ?? 0,
					earningAmount: roundMoney(heldByType.find((r: any) => r._id === "earning.held")?.amount ?? 0),
				},
			},
			blocked: {
				days: dayList,
				signup: series(blockedByDay, "point", "signup"),
				signin: series(blockedByDay, "point", "signin"),
				booking: series(blockedByDay, "point", "booking"),
			},
			trends: {
				hits: { current: trend[0], previous: trend[1] },
				casesOpened: { current: trend[2], previous: trend[3] },
				blockedAttempts: { current: trend[4], previous: trend[5] },
				label: "last 7 days vs the 7 before",
			},
			rules: {
				total: rules.length,
				byMode: {
					off: rules.filter((r: any) => r.mode === "off").length,
					observe: rules.filter((r: any) => r.mode === "observe").length,
					enforce: rules.filter((r: any) => r.mode === "enforce").length,
				},
			},
		});
	} catch (error) {
		answerError(res, error, "building the risk overview");
	}
};

// --- Signals and rules -------------------------------------------------------------------------------------------

/** GET /admin/risk/signals */
export const handleListSignals = (_req: Request, res: Response) => {
	res.json({ signals: signalCatalogue(), actions: RULE_ACTION_LABELS });
};

const ruleView = (doc: any) => ({
	_id: String(doc._id),
	key: doc.key,
	title: doc.title,
	explanation: doc.explanation ?? "",
	match: doc.match,
	conditions: (doc.conditions ?? []).map((c: any) => ({
		signal: c.signal,
		op: c.op,
		value: c.value,
		signalLabel: SIGNAL_BY_KEY.get(c.signal)?.label ?? c.signal,
	})),
	weight: doc.weight,
	severity: doc.severity,
	actions: doc.actions,
	mode: doc.mode,
	isDefault: !!doc.isDefault,
	version: doc.version ?? 1,
	hits: doc.hits ?? 0,
	lastFiredAt: doc.lastFiredAt ?? null,
	modeChangedAt: doc.modeChangedAt ?? null,
	createdAt: doc.createdAt ?? null,
	updatedAt: doc.updatedAt ?? null,
	updatedBy: doc.updatedBy?.email ? { id: String(doc.updatedBy.id), email: doc.updatedBy.email } : null,
});

/** GET /admin/risk/rules: every rule with hits in the last 30 days. */
export const handleListRules = async (_req: Request, res: Response) => {
	try {
		const [rules, recent] = await Promise.all([
			RiskRuleModel.find().sort({ severity: 1, key: 1 }).maxTimeMS(DETAIL_TIME_LIMIT_MS).lean().exec(),
			RiskHitModel.aggregate([
				{ $match: { at: { $gte: new Date(Date.now() - 30 * DAY) } } },
				{ $group: { _id: "$ruleKey", count: { $sum: 1 } } },
			]).option({ maxTimeMS: DETAIL_TIME_LIMIT_MS }),
		]);
		const recentBy = new Map(recent.map((r: any) => [r._id, r.count]));
		res.json({
			items: rules.map((rule) => ({ ...ruleView(rule), hits30d: recentBy.get(rule.key) ?? 0 })),
			defaultsMissing: DEFAULT_RULES.filter((d) => !rules.some((r) => r.key === d.key)).map((d) => d.key),
		});
	} catch (error) {
		answerError(res, error, "listing risk rules");
	}
};

/** GET /admin/risk/rules/:id */
export const handleGetRule = async (req: Request, res: Response) => {
	try {
		const rule = await RiskRuleModel.findById(req.params.id).lean().exec();
		if (!rule) return res.status(404).json({ message: "Rule not found." });
		const hits = await RiskHitModel.find({ ruleKey: rule.key }).sort({ at: -1 }).limit(25).lean().exec();
		const people = await loadPeople(hits.map((h) => h.userId));
		res.json({
			rule: ruleView(rule),
			recentHits: hits.map((h: any) => ({
				_id: String(h._id),
				at: h.at,
				mode: h.mode,
				userId: String(h.userId),
				person: people.get(String(h.userId)) ?? null,
				actionsTaken: h.actionsTaken,
				actionsWouldTake: h.actionsWouldTake,
				evidence: h.evidence,
			})),
		});
	} catch (error) {
		answerError(res, error, "getting a risk rule");
	}
};

const answerRuleError = (res: Response, error: unknown, what: string) => {
	if (error instanceof RuleValidationError)
		return res.status(400).json({ message: error.message, field: error.field });
	return answerError(res, error, what);
};

/** POST /admin/risk/rules: a new rule, created in observe mode unless another mode is given (enforce needs confirm). */
export const handleCreateRule = async (req: Request, res: Response) => {
	try {
		const { confirm, ...input } = req.body ?? {};
		const rule = validateRule({ mode: "observe", ...input }) as RuleDefinition;
		if (!rule.key) {
			rule.key = `custom_${Date.now().toString(36)}`;
		}
		if (rule.mode === "enforce" && confirm !== true) {
			return res.status(409).json({ code: "confirmation_required", message: enforceWarning(rule) });
		}
		if (await RiskRuleModel.exists({ key: rule.key })) {
			return res.status(409).json({ message: "A rule with this key already exists.", field: "key" });
		}
		const created = await RiskRuleModel.create({
			...rule,
			isDefault: false,
			createdBy: adminRef(req),
			updatedBy: adminRef(req),
			modeChangedAt: new Date(),
		});
		invalidateRules();
		await recordAudit(
			{
				action: "risk.rule_created",
				actor: adminActor(req),
				target: { type: "risk_rule", id: created._id },
				after: {
					key: rule.key,
					mode: rule.mode,
					weight: rule.weight,
					severity: rule.severity,
					actions: rule.actions,
					conditions: rule.conditions,
				},
			},
			req,
		);
		emitEvent(
			{
				type: "risk.rule_changed",
				actor: { type: "admin", id: req.admin!._id },
				properties: { ruleKey: rule.key, fields: ["created"], mode: rule.mode },
			},
			req,
		);
		res.status(201).json({ rule: ruleView(created.toObject()) });
	} catch (error) {
		answerRuleError(res, error, "creating a risk rule");
	}
};

const enforceWarning = (rule: Pick<RuleDefinition, "title" | "actions">) => {
	const acting = rule.actions.filter((a) => a !== "score").map((a) => RULE_ACTION_LABELS[a].toLowerCase());
	return `Enforcing "${rule.title}" means that from now on, when it fires, the system will ${acting.length ? acting.join(", ") : "only add to the score"}. Send confirm: true to go ahead.`;
};

/**
 * PATCH /admin/risk/rules/:id { title?, explanation?, match?, conditions?, weight?, severity?, actions?, mode?,
 * version, confirm? }. `version` must be the version read (409 when someone saved meanwhile). Switching to enforce
 * without confirm: true answers 409 confirmation_required with what enforcing will do.
 */
export const handleUpdateRule = async (req: Request, res: Response) => {
	try {
		const { confirm, version, ...input } = req.body ?? {};
		if (!Number.isInteger(version))
			return res.status(400).json({ message: "version is required.", field: "version" });
		if ("key" in input) return res.status(400).json({ message: "The key of a rule cannot change.", field: "key" });
		const changes = validateRule(input, true);
		if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to change." });
		const before: any = await RiskRuleModel.findById(req.params.id).lean().exec();
		if (!before) return res.status(404).json({ message: "Rule not found." });
		const after = { ...ruleFromDocument(before), ...changes } as RuleDefinition;
		if (changes.mode === "enforce" && before.mode !== "enforce" && confirm !== true) {
			return res.status(409).json({ code: "confirmation_required", message: enforceWarning(after) });
		}
		const updated: any = await RiskRuleModel.findOneAndUpdate(
			{ _id: before._id, version },
			{
				$set: {
					...changes,
					updatedBy: adminRef(req),
					...(changes.mode && changes.mode !== before.mode ? { modeChangedAt: new Date() } : {}),
				},
				$inc: { version: 1 },
			},
			{ new: true },
		)
			.lean()
			.exec();
		if (!updated) {
			return res
				.status(409)
				.json({
					code: "version_conflict",
					message: "Someone changed this rule meanwhile. Reload it and try again.",
				});
		}
		invalidateRules();
		const fields = Object.keys(changes);
		await recordAudit(
			{
				action: "risk.rule_updated",
				actor: adminActor(req),
				target: { type: "risk_rule", id: before._id },
				before: Object.fromEntries(fields.map((f) => [f, before[f]])),
				after: Object.fromEntries(fields.map((f) => [f, (changes as any)[f]])),
				metadata: { key: before.key, version: updated.version },
			},
			req,
		);
		emitEvent(
			{
				type: "risk.rule_changed",
				actor: { type: "admin", id: req.admin!._id },
				properties: { ruleKey: before.key, fields, mode: updated.mode },
			},
			req,
		);
		res.json({ rule: ruleView(updated) });
	} catch (error) {
		answerRuleError(res, error, "updating a risk rule");
	}
};

export const MAX_BACKTEST_DAYS = 90;

/**
 * GET /admin/risk/backtest?ruleId=…|rule=<JSON draft>&from=YYYY-MM-DD&to=YYYY-MM-DD. Read only (a GET, so the demo
 * admin can use it too): nothing is written, no action is taken.
 */
export const handleBacktest = async (req: Request, res: Response) => {
	try {
		const { values, rest } = takeParams(req.query as Record<string, unknown>, ["ruleId", "rule", "from", "to"]);
		if (Object.keys(rest).length)
			return res
				.status(400)
				.json({ message: `Unknown parameter ${Object.keys(rest)[0]}.`, field: Object.keys(rest)[0] });
		let rule: RuleDefinition;
		if (values.rule) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(values.rule);
			} catch {
				return res.status(400).json({ message: "rule must be JSON.", field: "rule" });
			}
			rule = {
				key: "draft",
				mode: "observe",
				...validateRule({ key: "draft", ...(parsed as object) }),
			} as RuleDefinition;
		} else if (values.ruleId && mongoose.isValidObjectId(values.ruleId)) {
			const doc = await RiskRuleModel.findById(values.ruleId).lean().exec();
			if (!doc) return res.status(404).json({ message: "Rule not found." });
			rule = ruleFromDocument(doc);
		} else {
			return res.status(400).json({ message: "Give ruleId or a draft rule.", field: "rule" });
		}
		const now = Date.now();
		const to = values.to ? Date.parse(`${values.to}T23:59:59.999Z`) : now;
		const from = values.from ? Date.parse(`${values.from}T00:00:00Z`) : to - 30 * DAY + 1;
		if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
			return res
				.status(400)
				.json({ message: "from and to must be dates (YYYY-MM-DD), from before to.", field: "from" });
		}
		if (to - from > MAX_BACKTEST_DAYS * DAY) {
			return res
				.status(400)
				.json({ message: `A backtest covers at most ${MAX_BACKTEST_DAYS} days.`, field: "from" });
		}
		const started = Date.now();
		const { ds, truncated } = await loadPeriodDataset(from, Math.min(to, now));
		const result = runBacktest(indexDataset(ds), rule, { from, to: Math.min(to, now) });
		const people = await loadPeople(result.subjects.map((s) => s.userId));
		res.json({
			rule: { key: rule.key, title: rule.title, mode: rule.mode, actions: rule.actions },
			...result,
			subjects: result.subjects.map((s) => ({ ...s, person: people.get(s.userId) ?? null })),
			truncated,
			tookMs: Date.now() - started,
			note: "Signals are computed from the records as they are now (a phone number changed since then reads as today's), and positions only exist from this release on.",
		});
	} catch (error) {
		answerRuleError(res, error, "running a backtest");
	}
};

// --- A person's risk ---------------------------------------------------------------------------------------------

/** The score explained now (computed fresh, nothing written), with every signal. */
const freshRisk = async (userId: string) => {
	const ds = await loadUserDataset(userId);
	if (!ds) return null;
	const rules = await activeRules();
	const index = indexDataset(ds);
	const signals = computeSignals(index, userId, Date.now());
	const hits = rules.map((rule) => evaluateRule(rule, signals)).filter(Boolean) as RuleHit[];
	const explained = explainScore(hits);
	return {
		...explained,
		evaluatedAt: new Date().toISOString(),
		signals: Object.entries(signals).map(([key, result]) => ({
			key,
			label: SIGNAL_BY_KEY.get(key)?.label ?? key,
			category: SIGNAL_BY_KEY.get(key)?.category ?? null,
			value: result.value,
			explanation: result.explanation,
		})),
	};
};

const holdView = (hold: any, people?: Map<string, any>) => ({
	_id: String(hold._id),
	userId: String(hold.userId),
	person: people?.get(String(hold.userId)) ?? undefined,
	kind: hold.kind,
	reason: hold.reason,
	source: {
		type: hold.source?.type,
		ruleKey: hold.source?.ruleKey ?? null,
		caseId: hold.source?.caseId ? String(hold.source.caseId) : null,
		adminEmail: hold.source?.adminEmail ?? null,
	},
	active: hold.active,
	createdAt: hold.createdAt,
	releasedAt: hold.releasedAt ?? null,
	releasedBy: hold.releasedBy?.email ? { email: hold.releasedBy.email } : null,
	releaseReason: hold.releaseReason ?? null,
	blocked: { payouts: hold.blocked?.payouts ?? 0, earnings: hold.blocked?.earnings ?? 0 },
});

/** GET /admin/risk/users/:id: what the risk panel shows. */
export const handleGetUserRisk = async (req: Request, res: Response) => {
	try {
		const user: any = await UserModel.findById(
			req.params.id,
			"firstName lastName email phone roles providerStatus suspended createdAt payoutHold",
		)
			.lean()
			.exec();
		if (!user) return res.status(404).json({ message: "User not found." });
		const [risk, stored, cases, holds, hits] = await Promise.all([
			freshRisk(String(user._id)),
			RiskScoreModel.findOne({ userId: user._id }, "score band evaluatedAt exempt").lean().exec(),
			RiskCaseModel.find(
				{ userId: user._id },
				"title severity score status subject createdAt assignee decision active",
			)
				.sort({ createdAt: -1 })
				.limit(10)
				.lean()
				.exec(),
			RiskHoldModel.find({ userId: user._id, active: true }).sort({ createdAt: -1 }).lean().exec(),
			RiskHitModel.find({ userId: user._id }, "ruleKey at mode severity actionsTaken actionsWouldTake")
				.sort({ at: -1 })
				.limit(20)
				.lean()
				.exec(),
		]);
		res.json({
			user: {
				_id: String(user._id),
				firstName: user.firstName,
				lastName: user.lastName,
				name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
				email: user.email,
				role: user.roles?.Provider ? "provider" : "customer",
				suspended: !!user.suspended,
				createdAt: user.createdAt ?? null,
			},
			risk,
			stored: stored
				? {
						score: stored.score,
						band: stored.band,
						evaluatedAt: stored.evaluatedAt,
						exempt: stored.exempt ?? null,
					}
				: null,
			payoutHold: user.payoutHold ?? null,
			holds: holds.map((h) => holdView(h)),
			cases: cases.map((c: any) => caseListItem(c)),
			recentHits: hits.map((h: any) => ({
				ruleKey: h.ruleKey,
				at: h.at,
				mode: h.mode,
				severity: h.severity,
				actionsTaken: h.actionsTaken,
				actionsWouldTake: h.actionsWouldTake,
			})),
		});
	} catch (error) {
		answerError(res, error, "getting a person's risk");
	}
};

/** GET /admin/risk/users/:id/graph?depth=2&maxNodes=40&maxLinksPerNode=15 */
export const handleUserGraph = async (req: Request, res: Response) => {
	try {
		const exists = await UserModel.exists({ _id: req.params.id });
		if (!exists) return res.status(404).json({ message: "User not found." });
		const limits = clampLimits({
			depth: Number(req.query.depth),
			maxNodes: Number(req.query.maxNodes),
			maxLinksPerNode: Number(req.query.maxLinksPerNode),
		});
		const graph = await buildLinkGraph(String(req.params.id), loadLinks, limits);
		const ids = graph.nodes.map((n) => n.id);
		const [people, scores] = await Promise.all([
			loadPeople(ids),
			RiskScoreModel.find({ userId: { $in: ids.map(oid) } }, "userId score band")
				.lean()
				.exec(),
		]);
		const scoreOf = new Map(scores.map((s: any) => [String(s.userId), s]));
		res.json({
			...graph,
			nodes: graph.nodes.map((node) => {
				const person: any = people.get(node.id);
				const score: any = scoreOf.get(node.id);
				return {
					...node,
					name: person?.name ?? "Unknown account",
					role: person?.role ?? null,
					suspended: !!person?.suspended,
					score: score?.score ?? null,
					band: score?.band ?? null,
				};
			}),
		});
	} catch (error) {
		answerError(res, error, "building the linked-accounts graph");
	}
};

// --- Cases -------------------------------------------------------------------------------------------------------

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

const caseListItem = (c: any, people?: Map<string, any>) => ({
	_id: String(c._id),
	title: c.title,
	status: c.status,
	severity: c.severity,
	severityRank: SEVERITY_ORDER[c.severity as keyof typeof SEVERITY_ORDER] ?? 3,
	score: c.score ?? 0,
	subject: { type: c.subject?.type, id: c.subject?.id ? String(c.subject.id) : null },
	userId: c.userId ? String(c.userId) : null,
	person: people && c.userId ? (people.get(String(c.userId)) ?? null) : undefined,
	rules: c.rules ?? [],
	assignee: c.assignee?.email ? { id: String(c.assignee.id), email: c.assignee.email } : null,
	decision: c.decision?.outcome ? { outcome: c.decision.outcome, at: c.decision.at } : null,
	createdAt: c.createdAt,
	updatedAt: c.updatedAt ?? c.createdAt,
});

export const CASE_LIST_SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", updatedAt: "updatedAt", score: "score" },
	defaultSort: "createdAt",
	filters: {
		status: {
			type: "custom",
			parse: (value) =>
				value === "active"
					? { active: true }
					: value === "closed"
						? { status: { $in: ["cleared", "confirmed"] } }
						: (CASE_STATUSES as readonly string[]).includes(value)
							? { status: value }
							: null,
		},
		severity: { type: "enum", path: "severity", values: ["low", "medium", "high", "critical"] },
		subjectType: { type: "enum", path: "subject.type", values: CASE_SUBJECT_TYPES },
		userId: { type: "objectId", path: "userId" },
		assignee: {
			type: "custom",
			parse: (value) =>
				value === "none"
					? { "assignee.id": null }
					: mongoose.isValidObjectId(value)
						? { "assignee.id": new mongoose.Types.ObjectId(value) }
						: null,
		},
	},
	dateField: "createdAt",
	maxPageSize: 100,
};

/** GET /admin/risk/cases (status=active|open|in_review|cleared|confirmed|closed, severity, subjectType, userId, assignee=<id>|none|me) */
export const handleListCases = async (req: Request, res: Response) => {
	try {
		const query = { ...(req.query as Record<string, unknown>) };
		if (query.assignee === "me") query.assignee = String(req.admin!._id);
		const parsed = parseListQuery(query, CASE_LIST_SPEC);
		const result = await runListQuery(RiskCaseModel, parsed, { map: (c: any) => c });
		const people = await loadPeople(result.items.map((c: any) => c.userId));
		res.json({ ...result, items: result.items.map((c: any) => caseListItem(c, people)) });
	} catch (error) {
		answerError(res, error, "listing risk cases");
	}
};

/** The person a subject is about: a user, a booking's customer, a payment's customer, a payout's provider. */
const subjectPerson = async (type: CaseSubjectType, id: string): Promise<string | null | undefined> => {
	if (type === "user") return (await UserModel.exists({ _id: id })) ? id : undefined;
	if (type === "booking") {
		const booking: any = await BookingModel.findById(id, "userId").lean().exec();
		return booking ? String(booking.userId) : undefined;
	}
	if (type === "payment") {
		const payment: any = await PaymentModel.findById(id, "bookingId").lean().exec();
		if (!payment) return undefined;
		const booking: any = await BookingModel.findById(payment.bookingId, "userId").lean().exec();
		return booking ? String(booking.userId) : null;
	}
	const payout: any = await PayoutModel.findById(id, "userId").lean().exec();
	return payout ? String(payout.userId) : undefined;
};

/** POST /admin/risk/cases { subjectType, subjectId, reason }: opens a case by hand (or answers the active one). */
export const handleOpenCase = async (req: Request, res: Response) => {
	try {
		const type = req.body.subjectType as CaseSubjectType;
		const id = String(req.body.subjectId);
		const userId = await subjectPerson(type, id);
		if (userId === undefined) return res.status(404).json({ message: "Subject not found." });
		const risk = userId ? await freshRisk(userId) : null;
		const { riskCase, created } = await openOrUpdateCase({
			subject: { type, id },
			userId,
			title: `Opened by an admin (${type})`,
			severity: risk?.band ?? "low",
			score: risk?.score ?? 0,
			rules: [],
			evidence: [],
			linked: { [`${type}Ids`]: type === "user" ? [] : [id] },
			openedBy: { type: "admin", adminId: req.admin!._id },
			by: by(req),
		});
		if (!created)
			return res
				.status(409)
				.json({ message: "This subject already has an open case.", caseId: String(riskCase._id) });
		await RiskCaseModel.updateOne(
			{ _id: riskCase._id },
			{ $push: { notes: { body: String(req.body.reason), author: adminRef(req), createdAt: new Date() } } },
		).exec();
		await recordAudit(
			{
				action: "risk.case_opened",
				actor: adminActor(req),
				target: { type: "risk_case", id: riskCase._id },
				reason: String(req.body.reason),
				metadata: { subjectType: type, subjectId: id },
			},
			req,
		);
		emitEvent(
			{
				type: "risk.case_opened",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { userId },
				properties: { caseId: String(riskCase._id), severity: riskCase.severity, rules: [], by: "admin" },
			},
			req,
		);
		res.status(201).json({ case: caseListItem(riskCase.toObject()) });
	} catch (error) {
		answerError(res, error, "opening a risk case");
	}
};

const moneyRow = (amount: unknown) => roundMoney(Number(amount) || 0);

/** GET /admin/risk/cases/:id: the case with its evidence, the person's explained score, timeline and records. */
export const handleGetCase = async (req: Request, res: Response) => {
	try {
		const riskCase: any = await RiskCaseModel.findById(req.params.id).lean().exec();
		if (!riskCase) return res.status(404).json({ message: "Case not found." });
		const userId = riskCase.userId ? String(riskCase.userId) : null;
		const uid = userId ? oid(userId) : null;
		const bookingIds = [
			...new Set([
				...(riskCase.linked?.bookingIds ?? []),
				...(riskCase.subject.type === "booking" ? [String(riskCase.subject.id)] : []),
			]),
		];
		const [risk, events, bookings, holds, hits, rules, audit, people] = await Promise.all([
			userId ? freshRisk(userId) : null,
			uid
				? EventModel.find({
						$or: [{ userId: uid }, { providerId: uid }],
						at: { $gte: new Date(Date.now() - 90 * DAY) },
					})
						.sort({ at: -1 })
						.limit(150)
						.maxTimeMS(DETAIL_TIME_LIMIT_MS)
						.lean()
						.exec()
				: [],
			BookingModel.find(
				uid
					? { $or: [{ _id: { $in: bookingIds.map(oid) } }, { userId: uid }, { providerId: uid }] }
					: { _id: { $in: bookingIds.map(oid) } },
			)
				.sort({ createdAt: -1 })
				.limit(30)
				.maxTimeMS(DETAIL_TIME_LIMIT_MS)
				.lean()
				.exec(),
			uid ? RiskHoldModel.find({ userId: uid }).sort({ createdAt: -1 }).limit(20).lean().exec() : [],
			uid ? RiskHitModel.find({ userId: uid }).sort({ at: -1 }).limit(50).lean().exec() : [],
			RiskRuleModel.find({ key: { $in: riskCase.rules ?? [] } }, "key title severity mode weight")
				.lean()
				.exec(),
			auditFor(req, "risk_case", riskCase._id),
			loadPeople([userId, ...(riskCase.linked?.userIds ?? [])]),
		]);
		const bookingIdList = (bookings as any[]).map((b) => b._id);
		const [payments, payouts] = await Promise.all([
			PaymentModel.find({
				$or: [
					{ bookingId: { $in: bookingIdList } },
					{ _id: { $in: (riskCase.linked?.paymentIds ?? []).map(oid) } },
				],
			})
				.sort({ createdAt: -1 })
				.limit(40)
				.lean()
				.exec(),
			uid || riskCase.linked?.payoutIds?.length
				? PayoutModel.find({
						$or: [
							...(uid ? [{ userId: uid }] : []),
							{ _id: { $in: (riskCase.linked?.payoutIds ?? []).map(oid) } },
						],
					})
						.sort({ createdAt: -1 })
						.limit(30)
						.lean()
						.exec()
				: [],
		]);
		res.json({
			case: {
				...caseListItem(riskCase),
				evidence: riskCase.evidence ?? [],
				linked: riskCase.linked ?? {},
				notes: (riskCase.notes ?? [])
					.map((n: any) => ({
						_id: String(n._id),
						body: n.body,
						author: { email: n.author?.email ?? null },
						createdAt: n.createdAt,
					}))
					.reverse(),
				history: riskCase.history ?? [],
				decision: riskCase.decision?.outcome
					? {
							outcome: riskCase.decision.outcome,
							reason: riskCase.decision.reason,
							by: { email: riskCase.decision.by?.email ?? null },
							at: riskCase.decision.at,
						}
					: null,
				openedBy: riskCase.openedBy ?? null,
				version: riskCase.version ?? 0,
			},
			person: userId ? (people.get(userId) ?? null) : null,
			linkedPeople: (riskCase.linked?.userIds ?? []).map((id: string) => people.get(id)).filter(Boolean),
			rules: rules.map((r: any) => ({
				key: r.key,
				title: r.title,
				severity: r.severity,
				mode: r.mode,
				weight: r.weight,
			})),
			risk,
			hits: (hits as any[]).map((h) => ({
				_id: String(h._id),
				ruleKey: h.ruleKey,
				at: h.at,
				mode: h.mode,
				severity: h.severity,
				actionsTaken: h.actionsTaken,
				actionsWouldTake: h.actionsWouldTake,
				evidence: h.evidence,
			})),
			timeline: (events as any[]).map(publicEvent).reverse(),
			bookings: (bookings as any[]).map((b) => ({
				_id: String(b._id),
				reference: b.reference ?? bookingReference(b._id),
				status: b.status,
				service: b.service,
				amount: moneyRow(b.rate * b.hours),
				hours: b.hours,
				startDate: b.startDate,
				createdAt: b.createdAt,
				acceptedAt: b.acceptedAt ?? null,
				startedAt: b.startedAt ?? null,
				completedAt: b.completedAt ?? null,
				cancelledAt: b.cancelledAt ?? null,
				role: userId && String(b.userId) === userId ? "customer" : "provider",
				customerId: String(b.userId),
				providerId: b.providerId ? String(b.providerId) : null,
			})),
			payments: (payments as any[]).map((p) => ({
				_id: String(p._id),
				bookingId: String(p.bookingId),
				amount: moneyRow(p.amount),
				status: p.status,
				createdAt: p.createdAt,
				refundStatus: p.refundId ? (p.refundStatus ?? null) : null,
				refundAmount: p.refundId ? moneyRow(p.refundAmount) : 0,
			})),
			payouts: (payouts as any[]).map((p) => ({
				_id: String(p._id),
				amount: moneyRow(p.amount),
				status: p.status,
				createdAt: p.createdAt,
				destination: {
					type: p.destinationDetails?.type ?? null,
					last4: p.destinationDetails?.last4 ?? null,
					country: p.destinationDetails?.country ?? null,
				},
			})),
			holds: (holds as any[]).map((h) => holdView(h)),
			audit,
		});
	} catch (error) {
		answerError(res, error, "getting a risk case");
	}
};

/** Appends to a case's history and emits risk.case_updated. */
const noteOnCase = async (req: Request, riskCase: any, action: string, detail: Record<string, unknown> = {}) => {
	await RiskCaseModel.updateOne(
		{ _id: riskCase._id },
		{ $push: { history: { at: new Date(), action, by: by(req), detail } }, $inc: { version: 1 } },
	).exec();
	emitEvent(
		{
			type: "risk.case_updated",
			actor: { type: "admin", id: req.admin!._id },
			subjects: { userId: riskCase.userId ?? undefined },
			properties: { caseId: String(riskCase._id), change: action },
		},
		req,
	);
};

const loadCase = (id: string) => RiskCaseModel.findById(id).lean().exec() as Promise<any>;

/** POST /admin/risk/cases/:id/assign { assignee: "me" | adminId | null } */
export const handleAssignCase = async (req: Request, res: Response) => {
	try {
		const riskCase = await loadCase(req.params.id);
		if (!riskCase) return res.status(404).json({ message: "Case not found." });
		const value = req.body.assignee;
		let assignee: { id: unknown; email: string } | null = null;
		if (value === "me") assignee = adminRef(req);
		else if (value) {
			const admin: any = await AdminModel.findById(value, "email disabled").lean().exec();
			if (!admin || admin.disabled) return res.status(404).json({ message: "Admin not found." });
			assignee = { id: admin._id, email: admin.email };
		}
		await RiskCaseModel.updateOne(
			{ _id: riskCase._id },
			assignee ? { $set: { assignee } } : { $unset: { assignee: 1 } },
		).exec();
		await recordAudit(
			{
				action: "risk.case_updated",
				actor: adminActor(req),
				target: { type: "risk_case", id: riskCase._id },
				before: { assignee: riskCase.assignee?.email ?? null },
				after: { assignee: assignee?.email ?? null },
			},
			req,
		);
		await noteOnCase(req, riskCase, "assigned", { assignee: assignee?.email ?? null });
		res.json({ assignee: assignee ? { id: String(assignee.id), email: assignee.email } : null });
	} catch (error) {
		answerError(res, error, "assigning a risk case");
	}
};

/** POST /admin/risk/cases/:id/status { status: open | in_review } */
export const handleCaseStatus = async (req: Request, res: Response) => {
	try {
		const status = req.body.status as "open" | "in_review";
		const before: any = await RiskCaseModel.findOneAndUpdate(
			{ _id: req.params.id, active: true },
			{ $set: { status } },
			{ new: false },
		)
			.lean()
			.exec();
		if (!before) {
			return (await RiskCaseModel.exists({ _id: req.params.id }))
				? res.status(409).json({ message: "This case is closed." })
				: res.status(404).json({ message: "Case not found." });
		}
		await recordAudit(
			{
				action: "risk.case_updated",
				actor: adminActor(req),
				target: { type: "risk_case", id: before._id },
				before: { status: before.status },
				after: { status },
			},
			req,
		);
		await noteOnCase(req, before, "status", { from: before.status, to: status });
		res.json({ status });
	} catch (error) {
		answerError(res, error, "changing a case's status");
	}
};

/** POST /admin/risk/cases/:id/notes { body } */
export const handleCaseNote = async (req: Request, res: Response) => {
	try {
		const riskCase = await loadCase(req.params.id);
		if (!riskCase) return res.status(404).json({ message: "Case not found." });
		const note = {
			_id: new mongoose.Types.ObjectId(),
			body: String(req.body.body).trim(),
			author: adminRef(req),
			createdAt: new Date(),
		};
		await RiskCaseModel.updateOne({ _id: riskCase._id }, { $push: { notes: note } }).exec();
		await recordAudit(
			{
				action: "risk.case_updated",
				actor: adminActor(req),
				target: { type: "risk_case", id: riskCase._id },
				after: { note: note.body },
			},
			req,
		);
		await noteOnCase(req, riskCase, "note");
		res.status(201).json({
			note: {
				_id: String(note._id),
				body: note.body,
				author: { email: req.admin!.email },
				createdAt: note.createdAt,
			},
		});
	} catch (error) {
		answerError(res, error, "adding a case note");
	}
};

/** POST /admin/risk/cases/:id/decide { outcome: cleared | confirmed, reason }: closes the case. */
export const handleDecideCase = async (req: Request, res: Response) => {
	try {
		const outcome = req.body.outcome as "cleared" | "confirmed";
		const reason = String(req.body.reason);
		const decision = { outcome, reason, by: adminRef(req), at: new Date() };
		const before: any = await RiskCaseModel.findOneAndUpdate(
			{ _id: req.params.id, active: true },
			{
				$set: { status: outcome, active: false, decision },
				$push: { history: { at: decision.at, action: "decided", by: by(req), detail: { outcome } } },
				$inc: { version: 1 },
			},
			{ new: false },
		)
			.lean()
			.exec();
		if (!before) {
			return (await RiskCaseModel.exists({ _id: req.params.id }))
				? res.status(409).json({ message: "This case is already decided." })
				: res.status(404).json({ message: "Case not found." });
		}
		await recordAudit(
			{
				action: "risk.case_decided",
				actor: adminActor(req),
				target: { type: "risk_case", id: before._id },
				before: { status: before.status },
				after: { status: outcome },
				reason,
			},
			req,
		);
		emitEvent(
			{
				type: "risk.case_decided",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { userId: before.userId ?? undefined },
				properties: { caseId: String(before._id), outcome },
			},
			req,
		);
		res.json({
			status: outcome,
			note:
				outcome === "cleared"
					? "Holds and suspensions are not lifted automatically: release or reinstate from the case if needed. Rules will not act on this person again for 30 days."
					: "Holds and suspensions stay as they are.",
		});
	} catch (error) {
		answerError(res, error, "deciding a risk case");
	}
};

const caseUser = async (res: Response, id: string) => {
	const riskCase = await loadCase(id);
	if (!riskCase) {
		res.status(404).json({ message: "Case not found." });
		return null;
	}
	if (!riskCase.userId) {
		res.status(409).json({ message: "This case is not about a person." });
		return null;
	}
	return riskCase;
};

/** Places a hold and records it (shared by the holds page and cases). */
const placeHoldFor = async (req: Request, res: Response, userId: string, kind: HoldKind, caseId?: unknown) => {
	const user: any = await UserModel.findById(userId, "roles").lean().exec();
	if (!user) return res.status(404).json({ message: "User not found." });
	if (!user.roles?.Provider) return res.status(409).json({ message: "Payout holds apply to providers only." });
	const reason = String(req.body.reason);
	const { hold, created } = await placeHold({
		userId,
		kind,
		reason,
		source: {
			type: caseId ? "case" : "admin",
			caseId: caseId as any,
			adminId: req.admin!._id,
			adminEmail: req.admin!.email,
		},
	});
	if (!created)
		return res
			.status(409)
			.json({
				message: "This provider already has an active hold of this kind.",
				hold: holdView(hold.toObject()),
			});
	await recordAudit(
		{
			action: "risk.hold_placed",
			actor: adminActor(req),
			target: { type: "user", id: userId },
			after: { kind, active: true },
			reason,
			metadata: { holdId: String(hold._id), caseId: caseId ? String(caseId) : null },
		},
		req,
	);
	emitEvent(
		{
			type: "risk.hold_placed",
			actor: { type: "admin", id: req.admin!._id },
			subjects: { userId, providerId: userId },
			properties: { holdId: String(hold._id), kind, by: caseId ? "case" : "admin" },
		},
		req,
	);
	return res.status(201).json({ hold: holdView(hold.toObject()) });
};

/** Releases a hold and records it. */
const releaseHoldFor = async (req: Request, holdId: string) => {
	const reason = String(req.body.reason);
	const released = await releaseHold(holdId, { by: adminRef(req), reason });
	if (!released) return null;
	await recordAudit(
		{
			action: "risk.hold_released",
			actor: adminActor(req),
			target: { type: "user", id: String(released.hold.userId) },
			before: { kind: released.hold.kind, active: true, since: released.hold.createdAt },
			after: { active: false, payoutHold: released.state },
			reason,
			metadata: { holdId, rescheduledEarnings: released.rescheduled },
		},
		req,
	);
	emitEvent(
		{
			type: "risk.hold_released",
			actor: { type: "admin", id: req.admin!._id },
			subjects: { userId: released.hold.userId, providerId: released.hold.userId },
			properties: { holdId, kind: released.hold.kind, rescheduledEarnings: released.rescheduled },
		},
		req,
	);
	return released;
};

/** POST /admin/risk/cases/:id/hold { kind, reason } */
export const handleCaseHold = async (req: Request, res: Response) => {
	try {
		const riskCase = await caseUser(res, req.params.id);
		if (!riskCase) return;
		await placeHoldFor(req, res, String(riskCase.userId), req.body.kind, riskCase._id);
		if (res.statusCode === 201) await noteOnCase(req, riskCase, "hold_placed", { kind: req.body.kind });
	} catch (error) {
		answerError(res, error, "placing a hold from a case");
	}
};

/** POST /admin/risk/cases/:id/release-holds { reason }: releases every active hold on the case's person. */
export const handleCaseReleaseHolds = async (req: Request, res: Response) => {
	try {
		const riskCase = await caseUser(res, req.params.id);
		if (!riskCase) return;
		const holds = await RiskHoldModel.find({ userId: riskCase.userId, active: true }, "_id").lean().exec();
		if (!holds.length) return res.status(409).json({ message: "This person has no active hold." });
		const released = [];
		for (const hold of holds) {
			const result = await releaseHoldFor(req, String(hold._id));
			if (result)
				released.push({
					holdId: String(hold._id),
					kind: result.hold.kind,
					rescheduledEarnings: result.rescheduled,
				});
		}
		await noteOnCase(req, riskCase, "holds_released", { count: released.length });
		res.json({ released });
	} catch (error) {
		answerError(res, error, "releasing holds from a case");
	}
};

/** Runs an existing operations handler for this case (same checks, audit and events) and notes it on the case. */
const delegate = async (
	req: Request,
	res: Response,
	riskCase: any,
	targetId: string,
	handler: (req: Request, res: Response) => Promise<unknown>,
	action: string,
) => {
	req.params.id = targetId;
	await handler(req, res);
	if (res.statusCode < 300) await noteOnCase(req, riskCase, action, { targetId });
};

/** POST /admin/risk/cases/:id/suspend { reason }: the operations suspension (also needs users.manage). */
export const handleCaseSuspend = async (req: Request, res: Response) => {
	try {
		if (!can(req, "users.manage")) return forbidden(res, "users.manage");
		const riskCase = await caseUser(res, req.params.id);
		if (!riskCase) return;
		await delegate(req, res, riskCase, String(riskCase.userId), handleSuspendUser, "suspended");
	} catch (error) {
		answerError(res, error, "suspending from a case");
	}
};

/** POST /admin/risk/cases/:id/reinstate { reason }: the operations reinstatement (also needs users.manage). */
export const handleCaseReinstate = async (req: Request, res: Response) => {
	try {
		if (!can(req, "users.manage")) return forbidden(res, "users.manage");
		const riskCase = await caseUser(res, req.params.id);
		if (!riskCase) return;
		await delegate(req, res, riskCase, String(riskCase.userId), handleReinstateUser, "reinstated");
	} catch (error) {
		answerError(res, error, "reinstating from a case");
	}
};

/**
 * POST /admin/risk/cases/:id/refund { paymentId, amount?, reason, idempotencyKey }: the operations refund (also needs
 * payments.refund), for a payment of the case's person or one linked to the case.
 */
export const handleCaseRefund = async (req: Request, res: Response) => {
	try {
		if (!can(req, "payments.refund")) return forbidden(res, "payments.refund");
		const riskCase = await loadCase(req.params.id);
		if (!riskCase) return res.status(404).json({ message: "Case not found." });
		const paymentId = String(req.body.paymentId);
		const payment: any = await PaymentModel.findById(paymentId, "bookingId").lean().exec();
		if (!payment) return res.status(404).json({ message: "Payment not found." });
		const booking: any = await BookingModel.findById(payment.bookingId, "userId providerId").lean().exec();
		const belongs =
			(riskCase.linked?.paymentIds ?? []).includes(paymentId) ||
			(riskCase.subject.type === "payment" && String(riskCase.subject.id) === paymentId) ||
			(!!riskCase.userId &&
				!!booking &&
				[String(booking.userId), String(booking.providerId)].includes(String(riskCase.userId)));
		if (!belongs) return res.status(409).json({ message: "This payment is not part of the case." });
		delete req.body.paymentId;
		await delegate(req, res, riskCase, paymentId, handleRefundPayment, "refunded");
	} catch (error) {
		answerError(res, error, "refunding from a case");
	}
};

// --- Holds -------------------------------------------------------------------------------------------------------

export const HOLD_LIST_SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", releasedAt: "releasedAt" },
	defaultSort: "-createdAt",
	filters: {
		active: { type: "boolean", path: "active" },
		kind: { type: "enum", path: "kind", values: HOLD_KINDS },
		userId: { type: "objectId", path: "userId" },
	},
	dateField: "createdAt",
	maxPageSize: 100,
};

/** GET /admin/risk/holds (active=true|false, kind, userId) */
export const handleListHolds = async (req: Request, res: Response) => {
	try {
		const result = await runListQuery(
			RiskHoldModel,
			parseListQuery(req.query as Record<string, unknown>, HOLD_LIST_SPEC),
			{ map: (h: any) => h },
		);
		const people = await loadPeople(result.items.map((h: any) => h.userId));
		res.json({ ...result, items: result.items.map((h: any) => holdView(h, people)) });
	} catch (error) {
		answerError(res, error, "listing payout holds");
	}
};

/** POST /admin/risk/holds { userId, kind, reason } */
export const handlePlaceHold = async (req: Request, res: Response) => {
	try {
		await placeHoldFor(req, res, String(req.body.userId), req.body.kind);
	} catch (error) {
		answerError(res, error, "placing a payout hold");
	}
};

/** POST /admin/risk/holds/:id/release { reason } */
export const handleReleaseHold = async (req: Request, res: Response) => {
	try {
		const released = await releaseHoldFor(req, req.params.id);
		if (!released) {
			return (await RiskHoldModel.exists({ _id: req.params.id }))
				? res.status(409).json({ message: "This hold is already released." })
				: res.status(404).json({ message: "Hold not found." });
		}
		res.json({
			hold: holdView({ ...released.hold.toObject(), active: false, releasedAt: new Date() }),
			payoutHold: released.state,
			rescheduledEarnings: released.rescheduled,
		});
	} catch (error) {
		answerError(res, error, "releasing a payout hold");
	}
};

// --- Lists -------------------------------------------------------------------------------------------------------

/** Field name per kind, so the demo-admin masking hides the value as it would anywhere else. */
const MASK_FIELD: Record<ListKind, string> = {
	email: "email",
	email_domain: "domain",
	device: "deviceId",
	ip: "ip",
	ip_range: "ip",
	phone: "phone",
};

const listView = (entry: any, demo: boolean) => {
	const field = MASK_FIELD[entry.kind as ListKind] ?? "value";
	const value = demo
		? (maskForDemo({ [field]: entry.value }, { exemptEmails: new Set() }) as any)[field]
		: entry.value;
	const now = Date.now();
	return {
		_id: String(entry._id),
		list: entry.list,
		kind: entry.kind,
		kindLabel: LIST_KIND_LABELS[entry.kind as ListKind],
		value,
		reason: entry.reason,
		status: entry.removedAt
			? "removed"
			: entry.expiresAt && new Date(entry.expiresAt).getTime() <= now
				? "expired"
				: "active",
		expiresAt: entry.expiresAt ?? null,
		removedAt: entry.removedAt ?? null,
		createdAt: entry.createdAt,
		createdBy: entry.createdBy?.email ? { email: entry.createdBy.email } : null,
		caseId: entry.caseId ? String(entry.caseId) : null,
		matches: entry.matches ?? 0,
		lastMatchedAt: entry.lastMatchedAt ?? null,
	};
};

export const LIST_LIST_SPEC: ListSpec = {
	sortable: { createdAt: "createdAt", expiresAt: "expiresAt", matches: "matches" },
	defaultSort: "-createdAt",
	filters: {
		list: { type: "enum", path: "list", values: ["block", "allow"] },
		kind: { type: "enum", path: "kind", values: ["email", "email_domain", "device", "ip", "ip_range", "phone"] },
		status: {
			type: "custom",
			parse: (value) =>
				value === "active"
					? { removedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }
					: value === "expired"
						? { removedAt: null, expiresAt: { $lte: new Date() } }
						: value === "removed"
							? { removedAt: { $ne: null } }
							: null,
		},
	},
	dateField: "createdAt",
	searchFields: ["value"],
	maxPageSize: 100,
};

/** GET /admin/risk/lists (list, kind, status=active|expired|removed, q) */
export const handleListEntries = async (req: Request, res: Response) => {
	try {
		const demo = isDemoAdmin(req.admin);
		const query = { ...(req.query as Record<string, unknown>) };
		// The demo admin cannot search by a value it cannot see.
		if (demo) delete query.q;
		const result = await runListQuery(RiskListModel, parseListQuery(query, LIST_LIST_SPEC), {
			map: (e: any) => listView(e, demo),
		});
		res.json(result);
	} catch (error) {
		answerError(res, error, "listing block and allow entries");
	}
};

const addEntry = async (req: Request, res: Response, list: ListType, caseId?: unknown) => {
	const kind = req.body.kind as ListKind;
	const value = normalizeListValue(kind, req.body.value);
	if (!value) {
		return res.status(400).json({
			message:
				kind === "ip_range"
					? "Give a range in CIDR form, at most /8 for IPv4 and /32 for IPv6 (for example 203.0.113.0/24)."
					: `That is not a valid ${LIST_KIND_LABELS[kind].toLowerCase()}.`,
			field: "value",
		});
	}
	const existing = await RiskListModel.findOne({
		list,
		kind,
		value,
		removedAt: null,
		$or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
	})
		.lean()
		.exec();
	if (existing)
		return res
			.status(409)
			.json({
				message: `This ${LIST_KIND_LABELS[kind].toLowerCase()} is already on the ${list} list.`,
				entry: listView(existing, false),
			});
	const entry = await RiskListModel.create({
		list,
		kind,
		value,
		reason: String(req.body.reason),
		expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
		createdBy: adminRef(req),
		caseId: caseId ?? null,
	});
	invalidateLists();
	await recordAudit(
		{
			action: "risk.list_entry_added",
			actor: adminActor(req),
			target: { type: "risk_list_entry", id: entry._id },
			after: { list, kind, value, expiresAt: entry.expiresAt },
			reason: String(req.body.reason),
			metadata: { caseId: caseId ? String(caseId) : null },
		},
		req,
	);
	emitEvent(
		{
			type: "risk.list_changed",
			actor: { type: "admin", id: req.admin!._id },
			properties: { entryId: String(entry._id), list, kind, change: "added" },
		},
		req,
	);
	return res.status(201).json({ entry: listView(entry.toObject(), false) });
};

/** POST /admin/risk/lists { list, kind, value, reason, expiresAt? } */
export const handleAddListEntry = async (req: Request, res: Response) => {
	try {
		await addEntry(req, res, req.body.list);
	} catch (error) {
		answerError(res, error, "adding a list entry");
	}
};

/** POST /admin/risk/cases/:id/block { kind, value, reason, expiresAt? }: a block entry linked to the case. */
export const handleCaseBlock = async (req: Request, res: Response) => {
	try {
		const riskCase = await loadCase(req.params.id);
		if (!riskCase) return res.status(404).json({ message: "Case not found." });
		await addEntry(req, res, "block", riskCase._id);
		if (res.statusCode === 201) await noteOnCase(req, riskCase, "blocked", { kind: req.body.kind });
	} catch (error) {
		answerError(res, error, "blocking from a case");
	}
};

/** PATCH /admin/risk/lists/:id { expiresAt (ISO or null), reason } */
export const handleUpdateListEntry = async (req: Request, res: Response) => {
	try {
		const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
		const before: any = await RiskListModel.findOneAndUpdate(
			{ _id: req.params.id, removedAt: null },
			{ $set: { expiresAt } },
			{ new: false },
		)
			.lean()
			.exec();
		if (!before) {
			return (await RiskListModel.exists({ _id: req.params.id }))
				? res.status(409).json({ message: "This entry was removed." })
				: res.status(404).json({ message: "Entry not found." });
		}
		invalidateLists();
		await recordAudit(
			{
				action: "risk.list_entry_updated",
				actor: adminActor(req),
				target: { type: "risk_list_entry", id: before._id },
				before: { expiresAt: before.expiresAt ?? null },
				after: { expiresAt },
				reason: String(req.body.reason),
			},
			req,
		);
		emitEvent(
			{
				type: "risk.list_changed",
				actor: { type: "admin", id: req.admin!._id },
				properties: {
					entryId: String(before._id),
					list: before.list,
					kind: before.kind,
					change: "expiry_changed",
				},
			},
			req,
		);
		res.json({ entry: listView({ ...before, expiresAt }, isDemoAdmin(req.admin)) });
	} catch (error) {
		answerError(res, error, "changing a list entry");
	}
};

/** DELETE /admin/risk/lists/:id { reason }: the entry stops applying at once (kept, marked removed). */
export const handleRemoveListEntry = async (req: Request, res: Response) => {
	try {
		const before: any = await RiskListModel.findOneAndUpdate(
			{ _id: req.params.id, removedAt: null },
			{ $set: { removedAt: new Date(), removedBy: adminRef(req) } },
			{ new: false },
		)
			.lean()
			.exec();
		if (!before) {
			return (await RiskListModel.exists({ _id: req.params.id }))
				? res.status(409).json({ message: "This entry was already removed." })
				: res.status(404).json({ message: "Entry not found." });
		}
		invalidateLists();
		await recordAudit(
			{
				action: "risk.list_entry_removed",
				actor: adminActor(req),
				target: { type: "risk_list_entry", id: before._id },
				before: { list: before.list, kind: before.kind, value: before.value },
				after: { removed: true },
				reason: String(req.body.reason),
			},
			req,
		);
		emitEvent(
			{
				type: "risk.list_changed",
				actor: { type: "admin", id: req.admin!._id },
				properties: { entryId: String(before._id), list: before.list, kind: before.kind, change: "removed" },
			},
			req,
		);
		res.status(204).end();
	} catch (error) {
		answerError(res, error, "removing a list entry");
	}
};
