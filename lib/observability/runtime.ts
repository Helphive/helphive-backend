// Wiring for the request path and the background work: the middleware that feeds request metrics and the error
// tracker, the log observer that remembers the error logged while a request was handled, the flush timers, release
// recording and the alert evaluator loop. Everything here is best effort: a failure is logged at WARNING (so it is
// never captured as an error itself) and the request is never delayed.
import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { observeErrorLogs, log, type LogEntry } from "../logger";
import { getRequestContext, type RequestContext } from "../requestContext";
import RequestMetricModel from "../../dal/models/obsRequestMetric.model";
import { ErrorCountModel, ErrorGroupModel, ErrorOccurrenceModel } from "../../dal/models/obsError.model";
import { ReleaseModel } from "../../dal/models/obsOps.model";
import { RequestMetricsAggregator, metricUpsert } from "./requestMetrics";
import { ErrorBuffer, groupUpdate, type CaptureInput } from "./errorTracker";
import { observabilityDisabled, releaseCommit, retention, revision, service } from "./config";
import { startAlertLoop } from "./alerts";

const QUIET = new Set(["/healthz", "/livez", "/readyz"]);
const FLUSH_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;

export const metrics = new RequestMetricsAggregator();
export const errorBuffer = new ErrorBuffer();

/** The first error logged while each request was handled, until its response finishes. */
const loggedErrors = new WeakMap<RequestContext, NonNullable<LogEntry["error"]> & { logMessage: string }>();
const finished = new WeakSet<RequestContext>();

export const dbReady = () => mongoose.connection.readyState === 1;

const lastWarning = new Map<string, number>();
/** WARNING at most every 10 minutes per topic. */
export const warnThrottled = (topic: string, error: unknown) => {
	const now = Date.now();
	if (now - (lastWarning.get(topic) ?? 0) < 10 * 60_000) return;
	lastWarning.set(topic, now);
	log.warn(`Observability: ${topic}`, { reason: error instanceof Error ? error.message : String(error) });
};

const actorIds = (context: RequestContext | undefined) => ({
	userId:
		context?.actor && context.actor.type !== "admin" && context.actor.type !== "anonymous"
			? context.actor.id
			: null,
	adminId: context?.actor?.type === "admin" ? context.actor.id : null,
});

/** Records an error for the tracker (also used by the client-error ingestion). Never throws. */
export const captureError = (input: Omit<CaptureInput, "revision"> & { revision?: string }) => {
	if (observabilityDisabled()) return null;
	try {
		return errorBuffer.add({ ...input, revision: input.revision ?? revision() });
	} catch (error) {
		warnThrottled("could not capture an error", error);
		return null;
	}
};

const onErrorLog = (entry: LogEntry) => {
	if (entry.message.startsWith("Observability")) return;
	const context = getRequestContext();
	const error = entry.error
		? { ...entry.error, logMessage: entry.message }
		: { message: entry.message, logMessage: entry.message };
	if (context && !finished.has(context)) {
		if (!loggedErrors.has(context)) loggedErrors.set(context, error);
		return;
	}
	// Outside a request, or work that carried on after the response (webhook handlers, notifications).
	captureError({
		source: "server",
		type: error.name ?? null,
		message: entry.error ? `${entry.message}: ${error.message}` : entry.message,
		stack: error.stack ?? null,
		route: context?.route ?? "(background)",
		requestId: context?.requestId ?? null,
		trace: context?.trace ?? null,
		...actorIds(context),
	});
};

let released = false;
const noteRelease = () => {
	if (released || !dbReady()) return;
	released = true;
	const now = new Date();
	ReleaseModel.updateOne(
		{ revision: revision() },
		{ $setOnInsert: { firstSeenAt: now, service: service(), commit: releaseCommit() }, $set: { lastSeenAt: now } },
		{ upsert: true },
	)
		.exec()
		.catch((error) => {
			released = false;
			warnThrottled("could not record the release", error);
		});
};

let lastReleaseTouch = 0;
const touchRelease = () => {
	if (!released || Date.now() - lastReleaseTouch < 10 * 60_000) return;
	lastReleaseTouch = Date.now();
	ReleaseModel.updateOne({ revision: revision() }, { $set: { lastSeenAt: new Date() } })
		.exec()
		.catch((error) => warnThrottled("could not update the release", error));
};

let flushTick = 0;
const flush = async () => {
	if (!dbReady()) return;
	flushTick++;
	const keep = retention();
	if (flushTick % 2 === 0 || metrics.size > 2000) {
		const cells = metrics.drain();
		if (cells.length) {
			await RequestMetricModel.collection
				.bulkWrite(cells.map((cell) => metricUpsert(cell, keep.metrics)) as any, { ordered: false })
				.catch((error) => warnThrottled("could not write request metrics", error));
		}
	}
	const { groups, occurrences } = errorBuffer.drain();
	if (groups.length) {
		const now = new Date();
		await ErrorGroupModel.collection
			.bulkWrite(
				groups.map((group) => ({
					updateOne: {
						filter: { fingerprint: group.fingerprint },
						update: groupUpdate(group, keep.errorGroups, now),
						upsert: true,
					},
				})) as any,
				{ ordered: false },
			)
			.catch((error) => warnThrottled("could not write error groups", error));
		await ErrorCountModel.collection
			.bulkWrite(
				groups.map((group) => {
					const hour = new Date(Math.floor(group.lastAt.getTime() / HOUR_MS) * HOUR_MS);
					return {
						updateOne: {
							filter: { fingerprint: group.fingerprint, hour },
							update: {
								$inc: { n: group.count },
								$setOnInsert: { expireAt: new Date(hour.getTime() + keep.metrics) },
							},
							upsert: true,
						},
					};
				}) as any,
				{ ordered: false },
			)
			.catch((error) => warnThrottled("could not write error counts", error));
	}
	if (occurrences.length) {
		await ErrorOccurrenceModel.collection
			.insertMany(
				occurrences.map((o) => ({ ...o, expireAt: new Date(o.at.getTime() + keep.errorOccurrences) })),
				{ ordered: false },
			)
			.catch((error) => warnThrottled("could not write error occurrences", error));
	}
	noteRelease();
	touchRelease();
};

let started = false;
/** Starts the log observer, the flush timer and the alert loop, once per process. */
export const startObservability = () => {
	if (started || observabilityDisabled()) return;
	started = true;
	observeErrorLogs(onErrorLog);
	let flushing = false;
	setInterval(() => {
		if (flushing) return;
		flushing = true;
		flush()
			.catch((error) => warnThrottled("flush failed", error))
			.finally(() => {
				flushing = false;
			});
	}, FLUSH_MS).unref();
	startAlertLoop();
};

/**
 * Mounted right after the request context: counts the request when its response finishes, and records a 5xx answer
 * (with the error logged while handling it) for the error tracker. Health probes and CORS preflights are skipped.
 */
export const observeRequests = (req: Request, res: Response, next: NextFunction) => {
	if (!started) startObservability();
	if (observabilityDisabled() || req.method === "OPTIONS" || QUIET.has(req.path)) return next();
	const begun = process.hrtime.bigint();
	res.on("finish", () => {
		try {
			const context = req.context;
			const status = res.statusCode;
			// "*" is the catch-all 404 route; no pattern means a limiter or CORS answered before routing.
			const pattern = context?.route === "*" ? undefined : context?.route;
			const route = pattern ?? (status === 404 ? "(not found)" : "(no route)");
			metrics.record({
				route,
				method: req.method,
				status,
				latencyMs: Number(process.hrtime.bigint() - begun) / 1e6,
				revision: revision(),
			});
			if (!context) return;
			finished.add(context);
			const logged = loggedErrors.get(context);
			loggedErrors.delete(context);
			if (status >= 500) {
				captureError({
					source: "server",
					type: logged?.name ?? `HTTP ${status}`,
					message: logged
						? `${logged.logMessage}: ${logged.message}`
						: `${req.method} ${route} answered ${status}`,
					stack: logged?.stack ?? null,
					route,
					method: req.method,
					status,
					requestId: context.requestId,
					trace: context.trace ?? null,
					appVersion: context.appVersion ?? null,
					...actorIds(context),
				});
			}
			if (!released) noteRelease();
		} catch (error) {
			warnThrottled("could not record a request", error);
		}
	});
	next();
};
