// The alert evaluator. Every minute each instance tries to take the "observability-evaluator" lease in MongoDB; the
// one holding it creates the default rules (disabled, once), runs the dependency checks every 5 minutes, evaluates
// every enabled rule, opens and resolves alerts, and emails a rule's recipients through lib/email.ts.
import mongoose from "mongoose";
import {
	AlertModel,
	AlertRuleModel,
	DependencyCheckModel,
	LeaseModel,
	ReleaseModel,
	type AlertRuleDoc,
} from "../../dal/models/obsOps.model";
import { ErrorGroupModel } from "../../dal/models/obsError.model";
import WebhookEventModel from "../../dal/models/webhookEvent.model";
import TaskRunModel from "../../dal/models/taskRun.model";
import EventModel from "../../dal/models/event.model";
import AuditLogModel from "../../dal/models/auditLog.model";
import AdminModel from "../../dal/models/admin.model";
import { sendEmail } from "../email";
import { SUPPORT_EMAIL } from "../../config/config";
import { AlertEmail } from "../../emails/alertEmail";
import log from "../logger";
import { Lease, type LeaseStore } from "./lease";
import { DEFAULT_RULES, alertTransition, evaluateRule, type WindowMeasures } from "./alertRules";
import { totalsFor } from "./queries";
import { checkDependencies, downMinutes } from "./dependencies";
import { INSTANCE_ID, alertsDisabled, consoleUrl, retention } from "./config";

const TICK_MS = 60_000;
const LEASE_MS = 3 * 60_000;
const DEPENDENCY_EVERY_MS = 5 * 60_000;

export const mongoLeaseStore: LeaseStore = {
	async tryTake(name, holder, now, expiresAt) {
		try {
			const result = await LeaseModel.findOneAndUpdate(
				{ _id: name, $or: [{ holder }, { expiresAt: { $lte: now } }] },
				{ $set: { holder, expiresAt } },
				{ upsert: true, new: true },
			)
				.lean()
				.exec();
			return result?.holder === holder;
		} catch (error: any) {
			// The upsert collides with a lease another holder still has.
			if (error?.code === 11000) return false;
			throw error;
		}
	},
	async release(name, holder) {
		await LeaseModel.deleteOne({ _id: name, holder }).exec();
	},
};

export const evaluatorLease = new Lease(mongoLeaseStore, "observability-evaluator", INSTANCE_ID, LEASE_MS);

const ensureDefaultRules = async () => {
	const now = new Date();
	await AlertRuleModel.bulkWrite(
		DEFAULT_RULES.map(({ key, ...rule }) => ({
			updateOne: {
				filter: { key },
				update: {
					$setOnInsert: {
						key,
						...rule,
						percentile: rule.percentile ?? null,
						minRequests: rule.minRequests ?? null,
						route: rule.route ?? null,
						dependency: rule.dependency ?? null,
						newReleaseOnly: rule.newReleaseOnly ?? null,
						recipients: [],
						createdAt: now,
						updatedAt: now,
						createdBy: null,
						updatedBy: null,
						deletedAt: null,
					},
				},
				upsert: true,
			},
		})),
		{ ordered: false },
	);
};

/** Measurements for one rule's window. Only what the rule's kind needs is queried. */
export const measureWindow = async (
	rule: Pick<AlertRuleDoc, "kind" | "minutes" | "route" | "dependency" | "newReleaseOnly">,
	now: Date,
): Promise<WindowMeasures> => {
	const from = new Date(now.getTime() - rule.minutes * 60_000);
	switch (rule.kind) {
		case "error_rate":
		case "latency":
		case "rate_limited": {
			const totals = await totalsFor({ from, to: now, route: rule.kind === "rate_limited" ? null : rule.route });
			return {
				requests: totals.n,
				errors: totals.s5,
				rateLimited: totals.rl,
				histogram: totals.h,
				maxMs: totals.max,
			};
		}
		case "webhook_failures":
			return {
				webhookFailures: await WebhookEventModel.countDocuments({
					outcome: "failed",
					receivedAt: { $gte: from },
				}).maxTimeMS(5000),
			};
		case "task_failures":
			return {
				taskFailures: await TaskRunModel.countDocuments({
					outcome: { $in: ["failed", "rejected"] },
					receivedAt: { $gte: from },
				}).maxTimeMS(5000),
			};
		case "failed_sign_ins": {
			const [users, admins] = await Promise.all([
				EventModel.countDocuments({ type: "auth.sign_in_failed", at: { $gte: from } }).maxTimeMS(5000),
				AuditLogModel.countDocuments({ action: "auth.login.failed", at: { $gte: from } }).maxTimeMS(5000),
			]);
			return { failedSignIns: users + admins };
		}
		case "dependency_down": {
			const checks = await DependencyCheckModel.find({ at: { $gte: new Date(now.getTime() - 24 * 60 * 60_000) } })
				.sort({ at: -1 })
				.limit(2000)
				.select("name status at")
				.lean();
			return { dependencyDownMinutes: downMinutes(checks, now) };
		}
		case "new_error_group": {
			const filter: Record<string, unknown> = { firstSeenAt: { $gte: from } };
			if (rule.newReleaseOnly) {
				const latest = await ReleaseModel.findOne().sort({ firstSeenAt: -1 }).select("revision").lean();
				if (latest) filter.firstRevision = latest.revision;
			}
			return { newErrorGroups: await ErrorGroupModel.countDocuments(filter).maxTimeMS(5000) };
		}
		default:
			return {};
	}
};

const notify = async (
	rule: AlertRuleDoc,
	alert: { _id: unknown; firedAt: Date; summary: string },
	state: "firing" | "resolved",
) => {
	if (!rule.recipients?.length) return { recipients: 0, sent: 0 };
	const admins = await AdminModel.find({ _id: { $in: rule.recipients }, disabled: { $ne: true } })
		.select("email")
		.lean();
	let sent = 0;
	for (const admin of admins) {
		const result = await sendEmail({
			template: "observability-alert",
			from: `HelpHive alerts <${SUPPORT_EMAIL}>`,
			to: admin.email,
			subject: `[${rule.severity}] ${state === "firing" ? "Firing" : "Resolved"}: ${rule.name}`,
			react: AlertEmail({
				ruleName: rule.name,
				severity: rule.severity,
				state,
				summary: alert.summary,
				firedAt: alert.firedAt,
				url: `${consoleUrl()}/observability/alerts/${String(alert._id)}`,
			}),
		});
		if (result.status === "sent") sent++;
	}
	return { recipients: admins.length, sent };
};

export const evaluateRules = async (now = new Date()) => {
	const rules = await AlertRuleModel.find({ deletedAt: null, enabled: true }).lean();
	for (const rule of rules) {
		try {
			const measures = await measureWindow(rule, now);
			const evaluation = evaluateRule(
				{
					kind: rule.kind as any,
					threshold: rule.threshold,
					minutes: rule.minutes,
					percentile: (rule.percentile ?? undefined) as any,
					minRequests: rule.minRequests ?? undefined,
					dependency: rule.dependency,
				},
				measures,
			);
			const open = await AlertModel.findOne({ ruleId: rule._id, status: { $ne: "resolved" } }).sort({
				firedAt: -1,
			});
			const lastResolved = open
				? null
				: await AlertModel.findOne({ ruleId: rule._id, status: "resolved" })
						.sort({ resolvedAt: -1 })
						.select("resolvedAt")
						.lean();
			const action = alertTransition(
				open,
				evaluation.breached,
				lastResolved?.resolvedAt ?? null,
				rule.cooldownMinutes,
				now,
			);
			if (action === "open") {
				const alert = await AlertModel.create({
					ruleId: rule._id,
					ruleName: rule.name,
					kind: rule.kind,
					severity: rule.severity,
					status: "firing",
					firedAt: now,
					value: evaluation.value,
					lastValue: evaluation.value,
					threshold: rule.threshold,
					summary: evaluation.summary,
					history: [{ at: now, status: "firing", by: null, note: evaluation.summary }],
				});
				const notified = await notify(rule, alert, "firing");
				await AlertModel.updateOne({ _id: alert._id }, { $set: { notified: { at: new Date(), ...notified } } });
				log.warn("alert_firing", `Alert firing: ${rule.name}`, {
					ruleId: String(rule._id),
					summary: evaluation.summary,
				});
			} else if (action === "resolve" && open) {
				await AlertModel.updateOne(
					{ _id: open._id, status: { $ne: "resolved" } },
					{
						$set: {
							status: "resolved",
							resolvedAt: now,
							lastValue: evaluation.value,
							expireAt: new Date(now.getTime() + retention().alerts),
						},
						$push: { history: { at: now, status: "resolved", by: null, note: evaluation.summary } },
					},
				);
				await notify(rule, { _id: open._id, firedAt: open.firedAt, summary: evaluation.summary }, "resolved");
			} else if (open) {
				await AlertModel.updateOne({ _id: open._id }, { $set: { lastValue: evaluation.value } });
			}
			await AlertRuleModel.updateOne(
				{ _id: rule._id },
				{ $set: { lastEvaluatedAt: now, lastValue: evaluation.value, lastSummary: evaluation.summary } },
			);
		} catch (error) {
			log.warn("alert_evaluation_failed", `Observability: could not evaluate alert rule ${rule.name}`, {
				reason: (error as Error)?.message,
			});
		}
	}
};

let defaultsCreated = false;
let lastDependencyRun = 0;

const tick = async () => {
	if (mongoose.connection.readyState !== 1) return;
	if (!(await evaluatorLease.acquire())) return;
	if (!defaultsCreated) {
		await ensureDefaultRules();
		defaultsCreated = true;
	}
	if (Date.now() - lastDependencyRun >= DEPENDENCY_EVERY_MS) {
		lastDependencyRun = Date.now();
		await checkDependencies({ fresh: true, record: true });
	}
	await evaluateRules();
};

export const startAlertLoop = () => {
	if (alertsDisabled()) return;
	let running = false;
	setInterval(() => {
		if (running) return;
		running = true;
		tick()
			.catch((error) =>
				log.warn("alert_evaluation_failed", "Observability: alert evaluation failed", {
					reason: error?.message,
				}),
			)
			.finally(() => {
				running = false;
			});
	}, TICK_MS).unref();
};
