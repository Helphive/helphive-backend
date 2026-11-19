// Observability console, read side and error-group status: request metrics, error tracking, the log explorer,
// dependencies and releases (routes/adminObservability.route.ts). Webhooks, tasks, alerts and client-error ingestion
// are in observabilityOps.controller.ts.
import type { Request, Response } from "express";
import mongoose from "mongoose";
import {
	ErrorCountModel,
	ErrorGroupModel,
	ErrorOccurrenceModel,
	ERROR_STATUSES,
} from "../../dal/models/obsError.model";
import { DependencyCheckModel, ReleaseModel, AlertModel } from "../../dal/models/obsOps.model";
import WebhookEventModel from "../../dal/models/webhookEvent.model";
import TaskRunModel from "../../dal/models/taskRun.model";
import { ListQueryError, parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import { answerError, takeParams } from "./operations.shared";
import {
	parseRange,
	routeTable,
	seriesFor,
	summarize,
	totalsFor,
	RANGES,
	type TimeWindow,
} from "../../lib/observability/queries";
import { parseLogQuery, requestLogsLink, traceLink } from "../../lib/observability/logQuery";
import { queryLogs } from "../../lib/observability/cloudLogging";
import { checkDependencies, DEPENDENCIES } from "../../lib/observability/dependencies";
import { revisionNumber } from "../../lib/observability/fingerprint";
import { projectId, revision, service } from "../../lib/observability/config";

const target = () => ({ project: projectId(), service: service() ?? undefined });
const minutesOf = (w: { from: Date; to: Date }) => (w.to.getTime() - w.from.getTime()) / 60_000;
const HOUR = 60 * 60_000;

/** Google Cloud links for a record with a request id. */
export const requestLinks = (requestId: string | null | undefined, at?: Date | null, trace?: string | null) => ({
	logsUrl: requestId ? requestLogsLink(requestId, target(), at ?? null) : null,
	traceUrl: traceLink(trace, projectId()),
});

const routeParam = (query: Record<string, unknown>) => {
	const { values } = takeParams(query, ["route", "method"]);
	if (values.route && !/^[/(][A-Za-z0-9_\-/:.*() ]{0,199}$/.test(values.route))
		throw new ListQueryError("Invalid route.", "route");
	if (values.method && !/^[A-Z]{3,7}$/.test(values.method)) throw new ListQueryError("Invalid method.", "method");
	return { route: values.route ?? null, method: values.method ?? null };
};

const onlyParams = (query: Record<string, unknown>, allowed: string[]) => {
	for (const key of Object.keys(query))
		if (!allowed.includes(key)) throw new ListQueryError(`Unknown parameter ${key}.`, key);
};

// --- Requests -----------------------------------------------------------------------------------------------------

/** GET /observability/requests/summary?range=&route=&method= : totals, series and status breakdown. */
export const handleRequestSummary = async (req: Request, res: Response) => {
	try {
		onlyParams(req.query, ["range", "route", "method"]);
		const window = parseRange(req.query.range);
		const { route, method } = routeParam(req.query);
		const filter = { from: window.from, to: window.to, route, method };
		const [totals, series, previous] = await Promise.all([
			totalsFor(filter),
			seriesFor(filter, window.bucketMs),
			totalsFor({
				...filter,
				from: new Date(window.from.getTime() - (window.to.getTime() - window.from.getTime())),
				to: window.from,
			}),
		]);
		res.json({
			range: window.range,
			from: window.from,
			to: window.to,
			bucketMs: window.bucketMs,
			route,
			method,
			totals: summarize(totals, minutesOf(window)),
			previous: summarize(previous, minutesOf(window)),
			series,
		});
	} catch (error) {
		answerError(res, error, "reading request metrics");
	}
};

/** GET /observability/requests/routes?range= : every route with rate, error rate, percentiles and sparklines. */
export const handleRouteTable = async (req: Request, res: Response) => {
	try {
		onlyParams(req.query, ["range"]);
		const window = parseRange(req.query.range);
		const routes = await routeTable(window);
		res.json({ range: window.range, from: window.from, to: window.to, items: routes });
	} catch (error) {
		answerError(res, error, "reading route metrics");
	}
};

/** GET /observability/requests/top?range= : slowest, most failing and most rate-limited routes. */
export const handleTopRoutes = async (req: Request, res: Response) => {
	try {
		onlyParams(req.query, ["range"]);
		const window = parseRange(req.query.range);
		const routes = await routeTable(window);
		const ranked = (key: (r: (typeof routes)[number]) => number | null, min = 1) =>
			routes
				.filter((r) => r.requests >= min && (key(r) ?? 0) > 0)
				.sort((a, b) => (key(b) ?? 0) - (key(a) ?? 0))
				.slice(0, 10);
		res.json({
			range: window.range,
			slowest: ranked((r) => r.p95, 5),
			failing: ranked((r) => r.errors),
			rateLimited: ranked((r) => r.rateLimited),
		});
	} catch (error) {
		answerError(res, error, "ranking routes");
	}
};

// --- Health overview ----------------------------------------------------------------------------------------------

/** GET /observability/overview?range= : the "is it working right now" page in one call. */
export const handleOverview = async (req: Request, res: Response) => {
	try {
		onlyParams(req.query, ["range"]);
		const window = parseRange(req.query.range, "6h");
		const filter = { from: window.from, to: window.to };
		const now = new Date();
		const since = new Date(now.getTime() - 24 * HOUR);
		const last15 = { from: new Date(now.getTime() - 15 * 60_000), to: now };
		const [totals, recent, series, releases, alerts, deps, webhookFailed, taskFailed, groups, newGroups] =
			await Promise.all([
				totalsFor(filter),
				totalsFor(last15),
				seriesFor(filter, window.bucketMs),
				ReleaseModel.find({ firstSeenAt: { $gte: new Date(window.from.getTime() - 30 * 24 * HOUR) } })
					.sort({ firstSeenAt: -1 })
					.limit(10)
					.lean(),
				AlertModel.find({ status: { $ne: "resolved" } })
					.sort({ firedAt: -1 })
					.limit(20)
					.lean(),
				checkDependencies({ fresh: false, record: false }),
				WebhookEventModel.find({ outcome: "failed", receivedAt: { $gte: since } })
					.sort({ receivedAt: -1 })
					.limit(5)
					.select("type eventId receivedAt error requestId")
					.lean(),
				TaskRunModel.find({ outcome: { $in: ["failed", "rejected"] }, receivedAt: { $gte: since } })
					.sort({ receivedAt: -1 })
					.limit(5)
					.select("task bookingId receivedAt error status requestId")
					.lean(),
				ErrorGroupModel.find({ status: "unresolved" }).sort({ lastSeenAt: -1 }).limit(6).lean(),
				ErrorGroupModel.countDocuments({ firstSeenAt: { $gte: since } }),
			]);
		const [webhookFailures, taskFailures] = await Promise.all([
			WebhookEventModel.countDocuments({ outcome: "failed", receivedAt: { $gte: since } }),
			TaskRunModel.countDocuments({ outcome: { $in: ["failed", "rejected"] }, receivedAt: { $gte: since } }),
		]);
		res.json({
			range: window.range,
			from: window.from,
			to: window.to,
			bucketMs: window.bucketMs,
			revision: revision(),
			totals: summarize(totals, minutesOf(window)),
			last15Minutes: summarize(recent, 15),
			series,
			releases: releases.map(publicRelease),
			alerts: alerts.map(publicAlertSummary),
			dependencies: deps.results,
			dependenciesCheckedAt: new Date(deps.cachedAt),
			webhooks: {
				failures24h: webhookFailures,
				recent: webhookFailed.map((w) => ({ ...w, id: String(w._id), _id: undefined })),
			},
			tasks: {
				failures24h: taskFailures,
				recent: taskFailed.map((t) => ({ ...t, id: String(t._id), _id: undefined })),
			},
			errors: { newGroups24h: newGroups, latest: groups.map(publicGroup) },
		});
	} catch (error) {
		answerError(res, error, "building the observability overview");
	}
};

// --- Errors -------------------------------------------------------------------------------------------------------

export const publicGroup = (g: any) => ({
	id: String(g._id),
	fingerprint: g.fingerprint,
	source: g.source,
	platform: g.platform,
	type: g.type,
	title: g.title,
	message: g.message,
	culprit: g.culprit,
	route: g.route,
	status: g.status,
	count: g.count,
	userCount: g.userCount ?? 0,
	firstSeenAt: g.firstSeenAt,
	lastSeenAt: g.lastSeenAt,
	firstRevision: g.firstRevision,
	lastRevision: g.lastRevision,
	appVersions: g.appVersions ?? [],
	lastAppVersion: g.lastAppVersion ?? null,
	statusChangedAt: g.statusChangedAt ?? null,
	statusChangedBy: g.statusChangedBy ?? null,
	resolvedInRevision: g.resolvedInRevision ?? null,
	reopenedAt: g.reopenedAt ?? null,
	reopenCount: g.reopenCount ?? 0,
});

export const ERROR_LIST_SPEC: ListSpec = {
	sortable: { lastSeenAt: "lastSeenAt", firstSeenAt: "firstSeenAt", count: "count", userCount: "userCount" },
	defaultSort: "-lastSeenAt",
	filters: {
		status: { type: "enum", path: "status", values: ERROR_STATUSES },
		source: { type: "enum", path: "source", values: ["server", "client"] },
		platform: { type: "string", path: "platform", maxLength: 20 },
		appVersion: { type: "string", path: "appVersions", maxLength: 32 },
		revision: { type: "string", path: "firstRevision", maxLength: 100 },
		route: { type: "string", path: "route", maxLength: 200 },
	},
	dateField: "lastSeenAt",
	searchFields: ["title", "message", "culprit", "route", "fingerprint"],
	maxPageSize: 100,
};

/** Hourly counts for the last `hours` hours per fingerprint, oldest first. */
const hourlyTrend = async (fingerprints: string[], hours: number) => {
	const end = Math.ceil(Date.now() / HOUR) * HOUR;
	const start = end - hours * HOUR;
	const rows = await ErrorCountModel.find({ fingerprint: { $in: fingerprints }, hour: { $gte: new Date(start) } })
		.select("fingerprint hour n")
		.lean();
	const trends = new Map<string, number[]>();
	for (const fp of fingerprints) trends.set(fp, Array(hours).fill(0));
	for (const row of rows) {
		const index = Math.floor((row.hour.getTime() - start) / HOUR);
		const trend = trends.get(row.fingerprint);
		if (trend && index >= 0 && index < hours) trend[index] += row.n;
	}
	return { start: new Date(start), trends };
};

/** GET /observability/errors : groups with filters, search and a 24-hour trend each. */
export const handleListErrors = async (req: Request, res: Response) => {
	try {
		const parsed = parseListQuery(req.query, ERROR_LIST_SPEC);
		const page = await runListQuery(ErrorGroupModel, parsed, { map: publicGroup });
		const { trends } = await hourlyTrend(
			page.items.map((g) => g.fingerprint),
			24,
		);
		res.json({ ...page, items: page.items.map((g) => ({ ...g, trend: trends.get(g.fingerprint) ?? [] })) });
	} catch (error) {
		answerError(res, error, "listing error groups");
	}
};

/** GET /observability/errors/facets : platforms, app versions and revisions seen, for the filters. */
export const handleErrorFacets = async (_req: Request, res: Response) => {
	try {
		const [platforms, versions, revisions] = await Promise.all([
			ErrorGroupModel.aggregate([
				{
					$group: {
						_id: { source: "$source", platform: "$platform" },
						groups: { $sum: 1 },
						count: { $sum: "$count" },
					},
				},
			]).option({ maxTimeMS: 5000 }),
			ErrorGroupModel.aggregate([
				{ $match: { source: "client" } },
				{ $unwind: "$appVersions" },
				{ $group: { _id: { platform: "$platform", version: "$appVersions" }, groups: { $sum: 1 } } },
				{ $sort: { "_id.version": -1 } },
				{ $limit: 200 },
			]).option({ maxTimeMS: 5000 }),
			ErrorGroupModel.distinct("firstRevision"),
		]);
		res.json({
			platforms: platforms.map((p) => ({
				source: p._id.source,
				platform: p._id.platform,
				groups: p.groups,
				count: p.count,
			})),
			appVersions: versions.map((v) => ({ platform: v._id.platform, version: v._id.version, groups: v.groups })),
			revisions: revisions.filter(Boolean).sort((a, b) => (revisionNumber(b) ?? 0) - (revisionNumber(a) ?? 0)),
		});
	} catch (error) {
		answerError(res, error, "reading error facets");
	}
};

const publicOccurrence = (o: any) => ({
	id: String(o._id),
	at: o.at,
	message: o.message,
	stack: o.stack,
	route: o.route,
	method: o.method,
	status: o.status,
	requestId: o.requestId,
	userId: o.userId,
	adminId: o.adminId,
	platform: o.platform,
	appVersion: o.appVersion,
	deviceId: o.deviceId,
	revision: o.revision,
	userAgent: o.userAgent,
	...requestLinks(o.requestId, o.at, o.trace),
});

/** GET /observability/errors/:id : the group, its latest occurrences, a 14-day trend, users and revisions. */
export const handleGetError = async (req: Request, res: Response) => {
	try {
		const group = await ErrorGroupModel.findById(req.params.id).lean();
		if (!group) return res.status(404).json({ message: "Error group not found." });
		const [occurrences, trend, revisions] = await Promise.all([
			ErrorOccurrenceModel.find({ fingerprint: group.fingerprint }).sort({ at: -1 }).limit(50).lean(),
			hourlyTrend([group.fingerprint], 24 * 14),
			ErrorOccurrenceModel.aggregate([
				{ $match: { fingerprint: group.fingerprint } },
				{ $group: { _id: "$revision", count: { $sum: 1 }, first: { $min: "$at" }, last: { $max: "$at" } } },
				{ $sort: { first: -1 } },
				{ $limit: 20 },
			]).option({ maxTimeMS: 5000 }),
		]);
		const daily: number[] = [];
		const hourly = trend.trends.get(group.fingerprint) ?? [];
		for (let i = 0; i < hourly.length; i += 24) daily.push(hourly.slice(i, i + 24).reduce((s, n) => s + n, 0));
		const users = (group.users ?? []) as string[];
		res.json({
			group: publicGroup(group),
			occurrences: occurrences.map(publicOccurrence),
			trend: { start: trend.start, hourly: hourly.slice(-48), daily },
			users: users.filter((u) => !u.startsWith("admin:")),
			admins: users.filter((u) => u.startsWith("admin:")).map((u) => u.slice(6)),
			revisions: revisions.map((r) => ({ revision: r._id, sampled: r.count, firstAt: r.first, lastAt: r.last })),
		});
	} catch (error) {
		answerError(res, error, "reading an error group");
	}
};

/** POST /observability/errors/:id/status { status: resolved|ignored|unresolved, reason? } */
export const handleSetErrorStatus = async (req: Request, res: Response) => {
	try {
		const status = req.body.status as "resolved" | "ignored" | "unresolved";
		const group = await ErrorGroupModel.findById(req.params.id).lean();
		if (!group) return res.status(404).json({ message: "Error group not found." });
		if (group.status === status) return res.status(409).json({ message: `This error is already ${status}.` });
		const now = new Date();
		const by = { id: String(req.admin!._id), email: req.admin!.email };
		// Resolved in the newest revision that saw it (or the one serving now): a later revision reopens it.
		const resolvedIn = status === "resolved" ? (group.lastRevision ?? revision()) : null;
		const updated = await ErrorGroupModel.findOneAndUpdate(
			{ _id: group._id, status: group.status },
			{
				$set: {
					status,
					statusChangedAt: now,
					statusChangedBy: by,
					resolvedInRevision: resolvedIn,
					resolvedRevisionNumber: resolvedIn ? revisionNumber(resolvedIn) : null,
				},
			},
			{ new: true },
		).lean();
		if (!updated) return res.status(409).json({ message: "This error changed meanwhile. Reload it." });
		await recordAudit(
			{
				action: "observability.error_status_changed",
				actor: adminActor(req),
				target: { type: "error_group", id: String(group._id) },
				before: { status: group.status },
				after: { status, resolvedInRevision: resolvedIn },
				reason: req.body.reason ? String(req.body.reason) : null,
				metadata: { fingerprint: group.fingerprint, title: group.title.slice(0, 200) },
			},
			req,
		);
		emitEvent(
			{
				type: "admin.action_taken",
				actor: { type: "admin", id: req.admin!._id },
				properties: { action: "observability.error_status_changed", targetType: "error_group", status },
			},
			req,
		);
		res.json({ group: publicGroup(updated) });
	} catch (error) {
		answerError(res, error, "changing an error group's status");
	}
};

// --- Logs ---------------------------------------------------------------------------------------------------------

/** GET /observability/logs?from&to&severity&requestId&route&userId&text&pageSize&pageToken */
export const handleLogs = async (req: Request, res: Response) => {
	try {
		const query = parseLogQuery(req.query);
		const result = await queryLogs(query);
		res.json({ ...result, from: query.from, to: query.to });
	} catch (error) {
		answerError(res, error, "querying logs");
	}
};

// --- Dependencies -------------------------------------------------------------------------------------------------

/** GET /observability/dependencies?fresh=true : current status (cached a minute unless fresh). */
export const handleDependencies = async (req: Request, res: Response) => {
	try {
		onlyParams(req.query, ["fresh"]);
		const fresh = req.query.fresh === "true";
		const { results, cachedAt } = await checkDependencies({ fresh, record: fresh });
		res.json({ items: results, checkedAt: new Date(cachedAt) });
	} catch (error) {
		answerError(res, error, "checking dependencies");
	}
};

/** GET /observability/dependencies/history?range= : uptime, latency and last error per dependency, with a series. */
export const handleDependencyHistory = async (req: Request, res: Response) => {
	try {
		onlyParams(req.query, ["range"]);
		const window = parseRange(req.query.range, "7d");
		const bucketMs = Math.max(window.bucketMs, 60 * 60_000);
		const rows = await DependencyCheckModel.aggregate([
			{ $match: { at: { $gte: window.from, $lt: window.to } } },
			{
				$group: {
					_id: {
						name: "$name",
						t: { $toDate: { $subtract: [{ $toLong: "$at" }, { $mod: [{ $toLong: "$at" }, bucketMs] }] } },
					},
					checks: { $sum: 1 },
					up: { $sum: { $cond: [{ $eq: ["$status", "down"] }, 0, 1] } },
					latency: { $avg: "$latencyMs" },
				},
			},
		]).option({ maxTimeMS: 5000 });
		const lastErrors = await DependencyCheckModel.aggregate([
			{ $match: { status: { $in: ["down", "degraded"] } } },
			{ $sort: { at: -1 } },
			{
				$group: {
					_id: "$name",
					at: { $first: "$at" },
					error: { $first: "$error" },
					status: { $first: "$status" },
				},
			},
		]).option({ maxTimeMS: 5000 });
		const start = Math.floor(window.from.getTime() / bucketMs) * bucketMs;
		const points = Math.ceil((window.to.getTime() - start) / bucketMs);
		const items = DEPENDENCIES.map((d) => {
			const mine = rows.filter((r) => r._id.name === d.name);
			const series = Array.from({ length: points }, (_, i) => {
				const t = start + i * bucketMs;
				const row = mine.find((r) => new Date(r._id.t).getTime() === t);
				return {
					t: new Date(t).toISOString(),
					checks: row?.checks ?? 0,
					uptime: row ? Math.round((1000 * row.up) / row.checks) / 10 : null,
					latencyMs: row?.latency != null ? Math.round(row.latency) : null,
				};
			});
			const checks = mine.reduce((s, r) => s + r.checks, 0);
			const up = mine.reduce((s, r) => s + r.up, 0);
			const last = lastErrors.find((e) => e._id === d.name);
			return {
				name: d.name,
				label: d.label,
				configured: d.enabled(),
				checks,
				uptime: checks ? Math.round((1000 * up) / checks) / 10 : null,
				lastProblem: last ? { at: last.at, status: last.status, error: last.error } : null,
				series,
			};
		});
		res.json({ range: window.range, from: window.from, to: window.to, bucketMs, items });
	} catch (error) {
		answerError(res, error, "reading dependency history");
	}
};

// --- Releases -----------------------------------------------------------------------------------------------------

export const publicRelease = (r: any) => ({
	revision: r.revision,
	service: r.service ?? null,
	commit: r.commit ?? null,
	firstSeenAt: r.firstSeenAt,
	lastSeenAt: r.lastSeenAt,
});

const publicAlertSummary = (a: any) => ({
	id: String(a._id),
	ruleId: String(a.ruleId),
	ruleName: a.ruleName,
	kind: a.kind,
	severity: a.severity,
	status: a.status,
	firedAt: a.firedAt,
	summary: a.summary,
	value: a.value,
	threshold: a.threshold,
});

/** Error rate, latency and new error groups in the `hours` before and after a release went live. */
const releaseHealth = async (release: { revision: string; firstSeenAt: Date }, nextAt: Date | null, hours = 24) => {
	const at = release.firstSeenAt;
	const afterEnd = new Date(Math.min(at.getTime() + hours * HOUR, nextAt?.getTime() ?? Infinity, Date.now()));
	const before = { from: new Date(at.getTime() - hours * HOUR), to: at };
	const after = { from: at, to: afterEnd };
	const [b, a, newGroups] = await Promise.all([
		totalsFor(before),
		totalsFor({ ...after, revision: release.revision }),
		ErrorGroupModel.find({ firstRevision: release.revision }).sort({ count: -1 }).limit(20).lean(),
	]);
	return {
		windowHours: hours,
		before: summarize(b, minutesOf(before)),
		after: summarize(a, Math.max(1, minutesOf(after))),
		newErrorGroups: newGroups.map(publicGroup),
	};
};

/** GET /observability/releases : newest first, each with a short before/after comparison. */
export const handleListReleases = async (req: Request, res: Response) => {
	try {
		onlyParams(req.query, []);
		const releases = await ReleaseModel.find().sort({ firstSeenAt: -1 }).limit(30).lean();
		const items = await Promise.all(
			releases.map(async (release, index) => {
				const next = index > 0 ? releases[index - 1].firstSeenAt : null;
				const health = index < 10 ? await releaseHealth(release, next) : null;
				return {
					...publicRelease(release),
					current: release.revision === revision(),
					health: health && {
						...health,
						newErrorGroups: undefined,
						newErrorGroupCount: health.newErrorGroups.length,
					},
				};
			}),
		);
		res.json({ items, currentRevision: revision() });
	} catch (error) {
		answerError(res, error, "listing releases");
	}
};

/** GET /observability/releases/:revision : before/after health with series and the new error groups. */
export const handleGetRelease = async (req: Request, res: Response) => {
	try {
		const name = req.params.revision;
		if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return res.status(400).json({ message: "Invalid revision." });
		const release = await ReleaseModel.findOne({ revision: name }).lean();
		if (!release) return res.status(404).json({ message: "Release not found." });
		const next = await ReleaseModel.findOne({ firstSeenAt: { $gt: release.firstSeenAt } })
			.sort({ firstSeenAt: 1 })
			.lean();
		const previous = await ReleaseModel.findOne({ firstSeenAt: { $lt: release.firstSeenAt } })
			.sort({ firstSeenAt: -1 })
			.lean();
		const health = await releaseHealth(release, next?.firstSeenAt ?? null);
		const around: TimeWindow = {
			range: "24h",
			from: new Date(release.firstSeenAt.getTime() - 24 * HOUR),
			to: new Date(Math.min(release.firstSeenAt.getTime() + 24 * HOUR, Date.now())),
			bucketMs: RANGES["24h"].bucketMs * 2,
		};
		const series = await seriesFor({ from: around.from, to: around.to }, around.bucketMs);
		res.json({
			release: publicRelease(release),
			current: release.revision === revision(),
			previous: previous ? publicRelease(previous) : null,
			next: next ? publicRelease(next) : null,
			health,
			series,
		});
	} catch (error) {
		answerError(res, error, "reading a release");
	}
};

export const isObjectId = (value: unknown) =>
	typeof value === "string" && mongoose.Types.ObjectId.isValid(value) && /^[a-f\d]{24}$/i.test(value);
