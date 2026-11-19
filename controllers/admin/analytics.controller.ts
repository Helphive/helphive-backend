// Analytics for the admin console (GET /admin/analytics/*, permission analytics.read): the metric catalogue, time
// series with breakdowns and comparison, a multi-metric summary, funnels, retention cohorts, the supply-and-demand
// grids, leaderboards, distributions, CSV export and saved views. Metric definitions and pipeline builders live in
// lib/analytics/; this file validates the query, runs the pipelines (time-limited, cached briefly) and shapes answers.
import type { Request, Response } from "express";
import type { Model } from "mongoose";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import UserModel from "../../dal/models/user.model";
import EventModel from "../../dal/models/event.model";
import ProviderApplicationModel from "../../dal/models/providerapplication.model";
import AnalyticsViewModel from "../../dal/models/analyticsView.model";
import { isDemoAdmin } from "../../config/adminPermissions";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import log from "../../lib/logger";
import { TtlCache } from "../../lib/analytics/cache";
import {
	assemble,
	combineDerived,
	repeatRates,
	type Assembled,
	type Row,
	type Stat,
} from "../../lib/analytics/compute";
import {
	BREAKDOWNS,
	buildSeriesPipeline,
	GROUPS,
	METRICS,
	metricById,
	UNITS,
	type AggregateMetric,
	type Breakdown,
	type MetricDef,
} from "../../lib/analytics/metrics";
import {
	addMonths,
	daysBetween,
	dayIn,
	formatDay,
	INTERVALS,
	monthsBetween,
	previousRange,
	type Day,
	type Interval,
	type ResolvedRange,
} from "../../lib/analytics/periods";
import {
	AnalyticsQueryError,
	autoInterval,
	cacheKey,
	intParam,
	oneOf,
	parseSeriesQuery,
	parseSummaryQuery,
	RANGE_PRESETS,
	rangeDays,
	rangeParam,
	resolveOrThrow,
	takeStrings,
	timeZoneParam,
	type RangeRequest,
} from "../../lib/analytics/query";
import {
	CUSTOMER_FUNNEL,
	customerCohortPipeline,
	customerFunnelPipeline,
	customerLeaderboardPipeline,
	demandAreaPipeline,
	demandGridPipeline,
	DISTRIBUTIONS,
	distributionPipeline,
	LEADERBOARD_LIMIT,
	PROVIDER_FUNNEL,
	providerCohortPipeline,
	providerFunnelPipeline,
	providerLeaderboardPipeline,
	repeatBookingPipeline,
	SERVICES,
	supplyAreaPipeline,
	supplyGridPipeline,
	type DistributionId,
} from "../../lib/analytics/reports";
import { cohortMatrix, delta, distribution, funnel, histogram } from "../../lib/analytics/stats";
import { parseViewBody, MAX_VIEWS_PER_ADMIN } from "../../lib/analytics/views";

const QUERY_TIME_LIMIT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

const MODELS: Record<string, Model<any>> = {
	bookings: BookingModel,
	payments: PaymentModel,
	earnings: EarningModel,
	users: UserModel,
	events: EventModel,
	providerapplications: ProviderApplicationModel,
};

const cache = new TtlCache<unknown>(CACHE_TTL_MS, 500);
const cached = <T>(key: string, compute: () => Promise<T>) => cache.get(key, compute) as Promise<T>;

/** Exposed for tests. */
export const clearAnalyticsCache = () => cache.clear();

const run = <T = any>(model: Model<any>, pipeline: object[]): Promise<T[]> =>
	model
		.aggregate(pipeline as any[])
		.option({ maxTimeMS: QUERY_TIME_LIMIT_MS })
		.exec() as Promise<T[]>;

class QueryTimeout extends Error {}

const answerError = (res: Response, error: unknown, what: string) => {
	if (error instanceof AnalyticsQueryError)
		return res.status(400).json({ message: error.message, field: error.field });
	const code = (error as { code?: number; codeName?: string })?.code;
	if (error instanceof QueryTimeout || code === 50 || (error as any)?.codeName === "MaxTimeMSExpired") {
		return res
			.status(503)
			.json({ message: "That query took too long. Choose a shorter range or a longer interval." });
	}
	log.error(`Error ${what}`, error);
	return res.status(500).json({ message: "Internal server error" });
};

// ---------------------------------------------------------------------------------------------------------------
// Ranges

/** The first record's day in `tz` (for "all time"), cached for 10 minutes. */
const earliestDay = (tz: string): Promise<Day | null> =>
	cached(`earliest|${tz}`, async () => {
		const [user, booking] = await Promise.all([
			UserModel.findOne({}, { createdAt: 1 }).sort({ createdAt: 1 }).lean().exec(),
			BookingModel.findOne({}, { createdAt: 1 }).sort({ createdAt: 1 }).lean().exec(),
		]);
		const times = [user?.createdAt, booking?.createdAt]
			.map((d) => (d ? new Date(d as Date).getTime() : NaN))
			.filter(Number.isFinite);
		return times.length ? dayIn(Math.min(...times), tz) : null;
	});

const resolveRequest = async (req: RangeRequest, tz: string, interval: Interval | "auto", now = new Date()) => {
	const earliest = req.preset === "all" ? await earliestDay(tz) : null;
	const { fromDay, toDay } = rangeDays(req, now, tz, earliest);
	const days = daysBetween(fromDay, toDay) + 1;
	return resolveOrThrow(fromDay, toDay, tz, interval === "auto" ? autoInterval(days) : interval);
};

const rangeOut = (r: ResolvedRange, preset?: string) => ({
	from: formatDay(r.fromDay),
	to: formatDay(r.toDay),
	timeZone: r.tz,
	interval: r.interval,
	days: r.days,
	...(preset ? { preset } : {}),
});

// ---------------------------------------------------------------------------------------------------------------
// Computing a metric over a range

const approvedProviders = () =>
	cached("approvedProviders", () =>
		UserModel.countDocuments({ "roles.Provider": true, providerStatus: "approved" }).exec(),
	);

const computeAggregate = async (
	def: AggregateMetric,
	r: ResolvedRange,
	breakdown: Breakdown | null,
	stat: Stat,
	now: Date,
): Promise<Assembled> => {
	const model = MODELS[def.source.collection];
	const input = { start: r.start, end: r.end, interval: r.interval, tz: r.tz, breakdown, now };
	const needsTotals = def.op === "distinct" || def.op === "perDistinct";
	const [rows, totalRows] = await Promise.all([
		run<Row>(model, buildSeriesPipeline(def, input)),
		needsTotals ? run<Row>(model, buildSeriesPipeline(def, input, false)) : Promise.resolve(undefined),
	]);
	return assemble(def, r, rows, stat, totalRows);
};

/** A metric's assembled values over a range (cached per metric, range, breakdown and statistic). */
export const computeMetric = (
	def: MetricDef,
	r: ResolvedRange,
	breakdown: Breakdown | null = null,
	stat: Stat = "p50",
	now = new Date(),
): Promise<Assembled> =>
	cached(
		cacheKey("metric", {
			id: def.id,
			from: r.start.toISOString(),
			to: r.end.toISOString(),
			interval: r.interval,
			tz: r.tz,
			breakdown,
			stat,
		}),
		async (): Promise<Assembled> => {
			if (def.kind === "aggregate") return computeAggregate(def, r, breakdown, stat, now);
			if (def.kind === "derived") {
				const inputs = await Promise.all(
					def.of.map((id) => computeMetric(metricById(id)!, r, null, stat, now)),
				);
				const ctx = def.id === "provider_utilisation" ? { approvedProviders: await approvedProviders() } : {};
				const { values, total } = combineDerived(def.combine, inputs, ctx, def.unit === "percent" ? 1 : 2);
				return { series: [], values, total, count: inputs.reduce((n, x) => n + x.count, 0) };
			}
			// repeat_booking_rate
			const customers = await run<{ first: Date; inRange: Date[] }>(
				BookingModel,
				repeatBookingPipeline(r.start, r.end),
			);
			const result = repeatRates(r, customers);
			return { series: [], values: result.values, total: result.total, count: result.count };
		},
	);

// Free-text breakdown labels (a customer's typed city, a cancellation reason) are not shown to the demo admin.
const MASKED_BREAKDOWNS: readonly Breakdown[] = ["city", "reason"];
const maskSeries = (req: Request, breakdown: Breakdown | null, a: Assembled): Assembled => {
	if (!breakdown || !MASKED_BREAKDOWNS.includes(breakdown) || !req.admin || !isDemoAdmin(req.admin)) return a;
	const noun = breakdown === "city" ? "City" : "Reason";
	return {
		...a,
		series: a.series.map((s, i) =>
			s.key === "other"
				? s
				: { ...s, key: `${breakdown}-${i + 1}`, label: `${noun} ${i + 1} (hidden in the demo)` },
		),
	};
};

const describe = (def: MetricDef) => ({
	id: def.id,
	label: def.label,
	description: def.description,
	computation: def.computation,
	group: def.group,
	unit: def.unit,
	good: def.good,
	kind: def.kind,
	breakdowns: def.breakdowns,
	distribution: def.kind === "aggregate" && def.op === "dist",
	drill: def.kind === "aggregate" && def.drill ? { path: def.drill.path, params: def.drill.params ?? {} } : null,
	note: def.note ?? null,
});

const drillFor = (def: MetricDef, r: ResolvedRange) => {
	if (def.kind !== "aggregate" || !def.drill) return null;
	const [fromKey, toKey] = def.drill.dateParams ?? ["from", "to"];
	return {
		path: def.drill.path,
		params: { ...(def.drill.params ?? {}), [fromKey]: formatDay(r.fromDay), [toKey]: formatDay(r.toDay) },
	};
};

// ---------------------------------------------------------------------------------------------------------------
// Endpoints

/** GET /admin/analytics/metrics: every metric's definition, the breakdowns, units and ranges. */
export const handleListMetrics = (_req: Request, res: Response) => {
	res.json({
		metrics: METRICS.map(describe),
		breakdowns: BREAKDOWNS,
		groups: GROUPS,
		units: UNITS,
		intervals: INTERVALS,
		ranges: RANGE_PRESETS,
		services: SERVICES,
		distributions: Object.entries(DISTRIBUTIONS).map(([id, d]) => ({ id, label: d.label, unit: d.unit })),
	});
};

const seriesAnswer = async (req: Request) => {
	const q = parseSeriesQuery(req.query as Record<string, unknown>);
	const now = new Date();
	const r = await resolveRequest(q.range, q.tz, q.interval, now);
	const prev = q.compare === "previous" ? previousRange(r) : null;
	const [current, previous] = await Promise.all([
		computeMetric(q.metric, r, q.breakdown, q.stat, now),
		prev ? computeMetric(q.metric, prev, null, q.stat, now) : Promise.resolve(null),
	]);
	const shown = maskSeries(req, q.breakdown, current);
	return {
		q,
		r,
		prev,
		body: {
			metric: describe(q.metric),
			range: rangeOut(r, q.range.preset),
			breakdown: q.breakdown,
			stat: q.metric.kind === "aggregate" && q.metric.op === "dist" ? q.stat : null,
			buckets: r.buckets.map((b) => b.key),
			values: shown.values,
			total: shown.total,
			count: shown.count,
			series: q.breakdown ? shown.series : [],
			previous:
				prev && previous
					? {
							range: rangeOut(prev),
							buckets: prev.buckets.map((b) => b.key),
							values: previous.values,
							total: previous.total,
						}
					: null,
			delta: previous ? delta(current.total, previous.total) : null,
			drill: drillFor(q.metric, r),
			generatedAt: now.toISOString(),
		},
	};
};

/** GET /admin/analytics/series */
export const handleSeries = async (req: Request, res: Response) => {
	try {
		res.json((await seriesAnswer(req)).body);
	} catch (error) {
		answerError(res, error, "computing an analytics series");
	}
};

const CSV_DANGER = /^[=+\-@\t\r]/;
export const csvCell = (value: unknown) => {
	if (value === null || value === undefined) return "";
	let text = String(value);
	if (typeof value === "string" && CSV_DANGER.test(text)) text = `'${text}`;
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** GET /admin/analytics/series.csv: the same query as /series, one row per bucket. */
export const handleSeriesCsv = async (req: Request, res: Response) => {
	try {
		const { q, r, body } = await seriesAnswer(req);
		const columns = body.series.length ? body.series.map((s) => s.label) : [body.metric.label];
		const header = ["period_start", ...columns, ...(body.previous ? ["previous_period_start", "previous"] : [])];
		const lines = [header.map(csvCell).join(",")];
		body.buckets.forEach((bucket, i) => {
			const values = body.series.length ? body.series.map((s) => s.values[i]) : [body.values[i]];
			const prev = body.previous ? [body.previous.buckets[i] ?? "", body.previous.values[i] ?? ""] : [];
			lines.push([bucket, ...values, ...prev].map(csvCell).join(","));
		});
		const name = `helphive-${q.metric.id}-${formatDay(r.fromDay)}-to-${formatDay(r.toDay)}${q.breakdown ? `-by-${q.breakdown}` : ""}.csv`;
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
		res.setHeader("Cache-Control", "no-store");
		res.send(`${lines.join("\r\n")}\r\n`);
	} catch (error) {
		answerError(res, error, "exporting an analytics series");
	}
};

/** GET /admin/analytics/summary: several metrics with totals, previous-period deltas and sparklines. */
export const handleSummary = async (req: Request, res: Response) => {
	try {
		const q = parseSummaryQuery(req.query as Record<string, unknown>);
		const now = new Date();
		const r = await resolveRequest(q.range, q.tz, q.interval, now);
		const prev = previousRange(r);
		const [items, activity] = await Promise.all([
			Promise.all(
				q.metrics.map(async (def) => {
					const [cur, before] = await Promise.all([
						computeMetric(def, r, null, "p50", now),
						computeMetric(def, prev, null, "p50", now),
					]);
					return {
						...describe(def),
						value: cur.total,
						previous: before.total,
						delta: delta(cur.total, before.total),
						count: cur.count,
						sparkline: cur.values,
						drill: drillFor(def, r),
					};
				}),
			),
			activitySpan(),
		]);
		res.json({
			range: rangeOut(r, q.range.preset),
			previousRange: rangeOut(prev),
			buckets: r.buckets.map((b) => b.key),
			metrics: items,
			activity,
			generatedAt: now.toISOString(),
		});
	} catch (error) {
		answerError(res, error, "computing the analytics summary");
	}
};

/** When the first and latest bookings were made, so the console can offer "all time" for an empty range. */
const activitySpan = () =>
	cached("activity", async () => {
		const [first, last, firstUser] = await Promise.all([
			BookingModel.findOne({}, { createdAt: 1 }).sort({ createdAt: 1 }).lean().exec(),
			BookingModel.findOne({}, { createdAt: 1 }).sort({ createdAt: -1 }).lean().exec(),
			UserModel.findOne({}, { createdAt: 1 }).sort({ createdAt: 1 }).lean().exec(),
		]);
		return {
			firstBookingAt: first?.createdAt ?? null,
			lastBookingAt: last?.createdAt ?? null,
			firstSignUpAt: firstUser?.createdAt ?? null,
		};
	});

const rangedParams = ["range", "from", "to", "tz"];

/** GET /admin/analytics/funnel?kind=customer|provider: people who signed up in the range, and how far they got. */
export const handleFunnel = async (req: Request, res: Response) => {
	try {
		const params = takeStrings(req.query as Record<string, unknown>, ["kind", ...rangedParams]);
		const kind = oneOf(params, "kind", ["customer", "provider"] as const, "customer");
		const tz = timeZoneParam(params);
		const r = await resolveRequest(rangeParam(params), tz, "month");
		const answer = await cached(
			cacheKey("funnel", { kind, from: r.start.toISOString(), to: r.end.toISOString() }),
			async () => {
				const steps = kind === "customer" ? CUSTOMER_FUNNEL : PROVIDER_FUNNEL;
				const pipeline =
					kind === "customer"
						? customerFunnelPipeline(r.start, r.end)
						: providerFunnelPipeline(r.start, r.end);
				const groups = await run<{ reached: boolean[]; count: number }>(UserModel, pipeline);
				return funnel(steps, groups);
			},
		);
		res.json({
			kind,
			range: rangeOut(r, rangeParam(params).preset),
			cohort: "Accounts created in the range; each later step counted to date, in order.",
			steps: answer,
		});
	} catch (error) {
		answerError(res, error, "computing a funnel");
	}
};

/** GET /admin/analytics/cohorts?subject=customers|providers&months=12 */
export const handleCohorts = async (req: Request, res: Response) => {
	try {
		const params = takeStrings(req.query as Record<string, unknown>, ["subject", "months", "tz"]);
		const subject = oneOf(params, "subject", ["customers", "providers"] as const, "customers");
		const months = intParam(params, "months", 1, 36, 12);
		const tz = timeZoneParam(params);
		const today = dayIn(Date.now(), tz);
		const cohortMonths = monthsBetween(
			addMonths({ year: today.year, month: today.month, day: 1 }, 1 - months),
			today,
		);
		// Activity up to the end of today in the zone (earlier history still decides each subject's first month).
		const r = resolveOrThrow(today, today, tz, "day");
		const lastMonth = cohortMonths[cohortMonths.length - 1];
		const rows = await cached(
			cacheKey("cohorts", { subject, months, tz, lastMonth, end: r.end.toISOString() }),
			async () => {
				const pairs = await run<{ id: string; month: string }>(
					subject === "customers" ? PaymentModel : BookingModel,
					subject === "customers" ? customerCohortPipeline(r.end, tz) : providerCohortPipeline(r.end, tz),
				);
				return cohortMatrix(pairs, cohortMonths, lastMonth);
			},
		);
		res.json({
			subject,
			timeZone: tz,
			months: cohortMonths,
			definition:
				subject === "customers"
					? "Customers by the month of their first paid booking; a later month counts when they paid for a booking in it."
					: "Providers by the month of their first completed job; a later month counts when they completed a job in it.",
			cohorts: rows,
		});
	} catch (error) {
		answerError(res, error, "computing retention cohorts");
	}
};

/** GET /admin/analytics/supply-demand?service=1|2|3: hour-of-week grid and coarse areas. */
export const handleSupplyDemand = async (req: Request, res: Response) => {
	try {
		const params = takeStrings(req.query as Record<string, unknown>, ["service", ...rangedParams]);
		const service = params.service ? intParam(params, "service", 1, 3, 0) : null;
		const tz = timeZoneParam(params);
		const r = await resolveRequest(rangeParam(params), tz, "month");
		const answer = await cached(
			cacheKey("supply", { service, tz, from: r.start.toISOString(), to: r.end.toISOString() }),
			async () => {
				const [demand, supply, areas, providers] = await Promise.all([
					run(BookingModel, demandGridPipeline(r.start, r.end, tz, service)),
					run(EventModel, supplyGridPipeline(r.start, r.end, tz, service)),
					run(BookingModel, demandAreaPipeline(r.start, r.end, service)),
					run(UserModel, supplyAreaPipeline(service)),
				]);
				return { demand, supply, areas, providers };
			},
		);
		res.json({
			range: rangeOut(r, rangeParam(params).preset),
			service: service ? SERVICES.find((s) => s.id === service) : null,
			days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
			grid: {
				definition:
					"Demand: bookings by booked start (day 1 = Monday, hour 0-23 in the time zone), and how many got a provider. Supply: distinct providers who went available in that hour (recorded from the event-stream release on).",
				demand: answer.demand,
				supply: answer.supply,
			},
			areas: {
				precision:
					"Positions rounded to 0.1 degree (about 11 km). Demand from booking locations; providers from their last known position today.",
				demand: answer.areas,
				providers: answer.providers,
			},
		});
	} catch (error) {
		answerError(res, error, "computing supply and demand");
	}
};

/** GET /admin/analytics/leaderboards?subject=customers|providers&by=value|count&limit=10 */
export const handleLeaderboard = async (req: Request, res: Response) => {
	try {
		const params = takeStrings(req.query as Record<string, unknown>, ["subject", "by", "limit", ...rangedParams]);
		const subject = oneOf(params, "subject", ["customers", "providers"] as const, "customers");
		const by = oneOf(params, "by", ["value", "count"] as const, "value");
		const limit = intParam(params, "limit", 1, LEADERBOARD_LIMIT, 10);
		const tz = timeZoneParam(params);
		const r = await resolveRequest(rangeParam(params), tz, "month");
		const rows = await cached(
			cacheKey("leaders", { subject, by, limit, from: r.start.toISOString(), to: r.end.toISOString() }),
			() =>
				subject === "customers"
					? run(PaymentModel, customerLeaderboardPipeline(r.start, r.end, by, limit))
					: run(EarningModel, providerLeaderboardPipeline(r.start, r.end, by, limit)),
		);
		res.json({
			subject,
			by,
			range: rangeOut(r, rangeParam(params).preset),
			definition:
				subject === "customers"
					? "Customers by money paid (completed payments by paid date) and number of paid bookings."
					: "Providers by earnings (not cancelled, by creation) and number of jobs earned from, with the hours.",
			items: rows.map((row: any, i: number) => ({
				rank: i + 1,
				_id: String(row._id),
				firstName: row.firstName ?? null,
				lastName: row.lastName ?? null,
				name: [row.firstName, row.lastName].filter(Boolean).join(" ") || null,
				email: row.email ?? null,
				value: Math.round((row.value ?? 0) * 100) / 100,
				count: row.count ?? 0,
				...(subject === "providers" ? { hours: row.hours ?? 0 } : {}),
			})),
		});
	} catch (error) {
		answerError(res, error, "computing a leaderboard");
	}
};

/** GET /admin/analytics/distribution?metric=provider_earnings|...: a histogram and percentiles. */
export const handleDistribution = async (req: Request, res: Response) => {
	try {
		const params = takeStrings(req.query as Record<string, unknown>, ["metric", "bins", ...rangedParams]);
		const id = oneOf(params, "metric", Object.keys(DISTRIBUTIONS) as DistributionId[], "provider_earnings");
		const bins = intParam(params, "bins", 3, 30, 12);
		const tz = timeZoneParam(params);
		const r = await resolveRequest(rangeParam(params), tz, "month");
		const values = await cached(
			cacheKey("dist", { id, from: r.start.toISOString(), to: r.end.toISOString() }),
			async () =>
				(
					await run<{ v: number }>(
						MODELS[DISTRIBUTIONS[id].collection],
						distributionPipeline(id, r.start, r.end),
					)
				).map((x) => x.v),
		);
		res.json({
			metric: { id, ...DISTRIBUTIONS[id] },
			range: rangeOut(r, rangeParam(params).preset),
			stats: distribution(values),
			histogram: histogram(values, bins),
		});
	} catch (error) {
		answerError(res, error, "computing a distribution");
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Saved views

const viewOut = (view: any, adminId: string) => ({
	_id: String(view._id),
	name: view.name,
	shared: !!view.shared,
	mine: String(view.ownerId) === adminId,
	ownerEmail: view.ownerEmail,
	query: view.query,
	createdAt: view.createdAt,
	updatedAt: view.updatedAt,
});

const viewEvent = (req: Request, action: string) =>
	emitEvent(
		{
			type: "admin.action_taken",
			actor: { type: "admin", id: req.admin!._id },
			properties: { action, targetType: "analytics_view" },
		},
		req,
	);

/** GET /admin/analytics/views: own views and those shared with every admin. */
export const handleListViews = async (req: Request, res: Response) => {
	try {
		takeStrings(req.query as Record<string, unknown>, []);
		const adminId = String(req.admin!._id);
		const views = await AnalyticsViewModel.find({ $or: [{ ownerId: req.admin!._id }, { shared: true }] })
			.sort({ updatedAt: -1 })
			.limit(200)
			.lean()
			.exec();
		res.json({ items: views.map((v) => viewOut(v, adminId)) });
	} catch (error) {
		answerError(res, error, "listing saved views");
	}
};

/** POST /admin/analytics/views { name, query, shared? } */
export const handleCreateView = async (req: Request, res: Response) => {
	try {
		const body = parseViewBody(req.body, false);
		const owned = await AnalyticsViewModel.countDocuments({ ownerId: req.admin!._id }).exec();
		if (owned >= MAX_VIEWS_PER_ADMIN) {
			return res
				.status(409)
				.json({ message: `You can keep up to ${MAX_VIEWS_PER_ADMIN} views. Delete one first.` });
		}
		const view = await AnalyticsViewModel.create({
			name: body.name,
			query: body.query,
			shared: body.shared ?? false,
			ownerId: req.admin!._id,
			ownerEmail: req.admin!.email,
		});
		await recordAudit(
			{
				action: "analytics.view_created",
				actor: adminActor(req),
				target: { type: "analytics_view", id: String(view._id) },
				after: { name: view.name, shared: view.shared, metric: view.query.metric },
			},
			req,
		);
		viewEvent(req, "analytics.view_created");
		res.status(201).json({ view: viewOut(view.toObject(), String(req.admin!._id)) });
	} catch (error) {
		answerError(res, error, "saving a view");
	}
};

const ownView = async (req: Request, res: Response) => {
	const view = await AnalyticsViewModel.findById(req.params.id).exec();
	if (!view || (String(view.ownerId) !== String(req.admin!._id) && !view.shared)) {
		res.status(404).json({ message: "View not found." });
		return null;
	}
	if (String(view.ownerId) !== String(req.admin!._id)) {
		res.status(403).json({ message: "Only the admin who saved a view can change or delete it." });
		return null;
	}
	return view;
};

/** PATCH /admin/analytics/views/:id { name?, query?, shared? }: rename, update or share one's own view. */
export const handleUpdateView = async (req: Request, res: Response) => {
	try {
		const body = parseViewBody(req.body, true);
		const view = await ownView(req, res);
		if (!view) return;
		const before = { name: view.name, shared: view.shared, metric: view.query.metric };
		if (body.name !== undefined) view.name = body.name;
		if (body.shared !== undefined) view.shared = body.shared;
		if (body.query !== undefined) view.set("query", body.query);
		await view.save();
		await recordAudit(
			{
				action: "analytics.view_updated",
				actor: adminActor(req),
				target: { type: "analytics_view", id: String(view._id) },
				before,
				after: { name: view.name, shared: view.shared, metric: view.query.metric },
			},
			req,
		);
		viewEvent(req, "analytics.view_updated");
		res.json({ view: viewOut(view.toObject(), String(req.admin!._id)) });
	} catch (error) {
		answerError(res, error, "updating a view");
	}
};

/** DELETE /admin/analytics/views/:id */
export const handleDeleteView = async (req: Request, res: Response) => {
	try {
		const view = await ownView(req, res);
		if (!view) return;
		await AnalyticsViewModel.deleteOne({ _id: view._id }).exec();
		await recordAudit(
			{
				action: "analytics.view_deleted",
				actor: adminActor(req),
				target: { type: "analytics_view", id: String(view._id) },
				before: { name: view.name, shared: view.shared, metric: view.query.metric },
			},
			req,
		);
		viewEvent(req, "analytics.view_deleted");
		res.status(204).end();
	} catch (error) {
		answerError(res, error, "deleting a view");
	}
};
