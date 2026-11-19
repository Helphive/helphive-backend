// Records each webhook event and each Cloud Tasks call with its outcome (collections webhookevents and taskruns), so
// the console can list, inspect and replay them. Recording never changes what a handler does: if the database is
// unreachable the handler still runs and the failure is only logged.
import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import WebhookEventModel, { type WebhookOutcome } from "../dal/models/webhookEvent.model";
import TaskRunModel, { type TaskOutcome } from "../dal/models/taskRun.model";
import { getRequestContext } from "./requestContext";
import log from "./logger";

const MAX_ERROR = 1000;
const RECORD_TIMEOUT_MS = 3000;

export interface WebhookDelivery {
	/** False when this event id was already processed: skip the handler (Stripe redelivered it). */
	shouldProcess: boolean;
	/** Call with what the handler's work came to. Safe to call once; later calls are ignored. */
	finish: (outcome: Exclude<WebhookOutcome, "received">, detail?: { note?: string; error?: unknown }) => void;
}

/** The id of the object an event is about (pi_..., re_..., po_...), so detail pages can find their events. */
export const webhookObjectId = (event: { data?: { object?: unknown } }): string | null => {
	const id = (event.data?.object as { id?: unknown } | undefined)?.id;
	return typeof id === "string" && id.length <= 255 ? id : null;
};

const errorText = (error: unknown) =>
	(error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error").slice(0, MAX_ERROR);

/**
 * Notes a verified Stripe event. The first delivery creates the record; a redelivery of an event that was already
 * processed answers `shouldProcess: false` (the event id is the idempotency key), anything else is processed again.
 */
export const beginStripeDelivery = async (
	endpoint: "platform" | "connected",
	event: { id: string; type: string; account?: string | null; livemode?: boolean; data?: { object?: unknown } },
): Promise<WebhookDelivery> => {
	const now = new Date();
	const objectId = webhookObjectId(event);
	const requestId = getRequestContext()?.requestId ?? null;
	let recordId: unknown = null;
	let shouldProcess = true;
	let timer: NodeJS.Timeout | undefined;
	try {
		const newId = new mongoose.Types.ObjectId();
		const record = WebhookEventModel.findOneAndUpdate(
			{ provider: "stripe", eventId: event.id },
			{
				$setOnInsert: {
					_id: newId,
					provider: "stripe",
					endpoint,
					eventId: event.id,
					type: event.type,
					account: event.account ?? null,
					objectId,
					livemode: event.livemode,
					receivedAt: now,
					outcome: "received",
				},
				$set: { lastDeliveryAt: now, requestId },
				$inc: { deliveries: 1 },
			},
			// Defaults would collide with $inc/$setOnInsert on the same paths; the insert sets what it needs.
			{ upsert: true, new: false, setDefaultsOnInsert: false },
		)
			.lean()
			.exec();
		// Stripe waits for the 200; a slow database must not hold it up for long.
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timed out recording the delivery")), RECORD_TIMEOUT_MS);
		});
		const previous = await Promise.race([record, timeout]);
		recordId = previous ? previous._id : newId;
		if (previous && (previous.outcome === "processed" || previous.outcome === "ignored")) shouldProcess = false;
	} catch (error) {
		log.error("Could not record a Stripe webhook delivery; processing it anyway", error);
	} finally {
		if (timer) clearTimeout(timer);
	}

	let finished = false;
	return {
		shouldProcess,
		finish: (outcome, detail = {}) => {
			if (finished || !recordId) return;
			finished = true;
			WebhookEventModel.updateOne(
				{ _id: recordId },
				{
					$set: {
						outcome,
						processedAt: new Date(),
						note: detail.note ? detail.note.slice(0, MAX_ERROR) : null,
						error: detail.error ? errorText(detail.error) : null,
					},
				},
			)
				.exec()
				.catch((error) => log.error("Could not record a Stripe webhook outcome", error));
		},
	};
};

/** Runs tracked handler work in the background and records how it ended. The work's own logging is unchanged. */
export const trackWebhookWork = (delivery: WebhookDelivery, work: Promise<string | void>) => {
	work.then(
		(note) => delivery.finish("processed", { note: note || undefined }),
		(error) => delivery.finish("failed", { error }),
	);
};

const header = (req: Request, name: string) => {
	const value = req.headers[name];
	return typeof value === "string" ? value.slice(0, 500) : null;
};

const numberHeader = (req: Request, name: string) => {
	const value = Number(header(req, name));
	return Number.isFinite(value) ? value : null;
};

/** Outcome of a task call from its response: 2xx with one of the "nothing to do" answers is skipped. */
export const taskOutcomeFor = (status: number, message: string | null): TaskOutcome => {
	if (status === 401) return "rejected";
	if (status >= 400) return "failed";
	if (
		message &&
		/not found|already|not pending|not completed|missing|required|insufficient|not completed stripe/i.test(message)
	) {
		return "skipped";
	}
	return "processed";
};

/**
 * Middleware for a Cloud Tasks route: records the call (task, Cloud Tasks headers, booking id, status, the handler's
 * message and duration) when the response finishes. Mount before the secret check so refused calls are recorded too.
 */
export const recordTaskRun = (task: string) => (req: Request, res: Response, next: NextFunction) => {
	const receivedAt = new Date();
	let message: string | null = null;
	const json = res.json.bind(res);
	res.json = (body?: unknown) => {
		const text = body && typeof body === "object" ? (body as { message?: unknown }).message : undefined;
		if (typeof text === "string") message = text.slice(0, MAX_ERROR);
		return json(body);
	};
	res.on("finish", () => {
		const processedAt = new Date();
		const outcome = taskOutcomeFor(res.statusCode, message);
		const bookingId = typeof req.body?.bookingId === "string" ? req.body.bookingId.slice(0, 64) : null;
		TaskRunModel.create({
			task,
			taskName: header(req, "x-cloudtasks-taskname"),
			queue: header(req, "x-cloudtasks-queuename"),
			retryCount: numberHeader(req, "x-cloudtasks-taskretrycount"),
			executionCount: numberHeader(req, "x-cloudtasks-taskexecutioncount"),
			bookingId,
			receivedAt,
			processedAt,
			durationMs: processedAt.getTime() - receivedAt.getTime(),
			status: res.statusCode,
			outcome,
			note: outcome === "failed" ? null : message,
			error: outcome === "failed" ? message : null,
			requestId: req.context?.requestId ?? null,
		}).catch((error) => log.error("Could not record a Cloud Tasks run", error));
	});
	next();
};
