// emitEvent(): record a business event without ever slowing or failing the request that caused it. The write is
// scheduled after the current tick and any error is logged, never thrown.
import type { Request } from "express";
import mongoose from "mongoose";
import EventModel from "../dal/models/event.model";
import { getRequestContext, type ActorType, type RequestContext } from "./requestContext";
import { redact } from "./redact";
import log from "./logger";
import type { EventType } from "./eventCatalogue";

export const SUBJECT_FIELDS = [
	"userId",
	"providerId",
	"bookingId",
	"paymentId",
	"payoutId",
	"applicationId",
	"earningId",
] as const;
export type SubjectField = (typeof SUBJECT_FIELDS)[number];

type Id = string | mongoose.Types.ObjectId | { toString(): string } | null | undefined;

export interface EventInput {
	type: EventType;
	at?: Date;
	actor?: { type: ActorType; id?: Id };
	subjects?: Partial<Record<SubjectField, Id>>;
	properties?: Record<string, unknown>;
	/** Deterministic key; a second event with the same key is ignored. */
	key?: string;
	source?: "live" | "backfill";
}

const toObjectId = (value: Id): mongoose.Types.ObjectId | undefined => {
	if (!value) return undefined;
	const text = String(value);
	return /^[a-f\d]{24}$/i.test(text) ? new mongoose.Types.ObjectId(text) : undefined;
};

/** The document for an event. Pure; exported for tests and the backfill. */
export const buildEvent = (input: EventInput, context: RequestContext | undefined, now = new Date()) => {
	const doc: Record<string, unknown> = {
		type: input.type,
		at: input.at ?? now,
		actor: (() => {
			const actor = input.actor ?? context?.actor ?? { type: "anonymous" as const };
			const id = actor.id ? String(actor.id) : undefined;
			return id ? { type: actor.type, id } : { type: actor.type };
		})(),
		properties:
			(redact(input.properties ?? {}, { maxDepth: 4, maxStringLength: 500 }) as Record<string, unknown>) ?? {},
		context: Object.fromEntries(
			Object.entries({
				ip: context?.ip,
				userAgent: context?.userAgent,
				platform: context?.platform,
				appVersion: context?.appVersion,
				deviceId: context?.deviceId,
				requestId: context?.requestId,
			}).filter(([, value]) => value !== undefined),
		),
		source: input.source ?? "live",
		v: 1,
	};
	for (const field of SUBJECT_FIELDS) {
		const id = toObjectId(input.subjects?.[field]);
		if (id) doc[field] = id;
	}
	if (input.key) doc.key = input.key;
	return doc;
};

const DUPLICATE_KEY = 11000;

let writer: (doc: Record<string, unknown>) => Promise<unknown> = (doc) => EventModel.collection.insertOne(doc);

/** Tests replace the database write; returns the previous writer. */
export const setEventWriter = (next: typeof writer) => {
	const previous = writer;
	writer = next;
	return previous;
};

type EventListener = (doc: Record<string, unknown>) => void;
const listeners: EventListener[] = [];

/** Called with each event after it is written (the risk engine, lib/risk/engine.ts). Listeners must not throw. */
export const onEventRecorded = (listener: EventListener) => {
	listeners.push(listener);
};

const notify = (doc: Record<string, unknown>) => {
	for (const listener of listeners) {
		try {
			listener(doc);
		} catch (error) {
			log.error("An event listener failed", error);
		}
	}
};

/**
 * Records an event in the background. Context (IP, user agent, app headers, request id, signed-in actor) comes from
 * `req` when given, else from the current request. Returns immediately; never throws.
 */
export const emitEvent = (input: EventInput, req?: Request): void => {
	let doc: Record<string, unknown>;
	try {
		doc = buildEvent(input, req?.context ?? getRequestContext());
	} catch (error) {
		log.error(`Could not build event ${input.type}`, error);
		return;
	}
	setImmediate(() => {
		writer(doc)
			.then(() => notify(doc))
			.catch((error: any) => {
				if (error?.code === DUPLICATE_KEY) return;
				log.error(`Could not record event ${input.type}`, error);
			});
	});
};

/** Actor type for a user document: provider when it has the provider role. */
export const userActorType = (user: { roles?: { Provider?: boolean } | null } | null | undefined): ActorType =>
	user?.roles?.Provider ? "provider" : "user";

/**
 * Sampling for noisy events (rate-limit refusals): the first per key in each window, and at most `maxPerMinute`
 * overall per instance. Counts what it drops so the next recorded event can say how many were suppressed.
 */
export class EventSampler {
	private readonly lastByKey = new Map<string, number>();
	private minuteStart = 0;
	private inMinute = 0;
	private suppressed = 0;

	constructor(
		private readonly perKeyWindowMs = 10 * 60 * 1000,
		private readonly maxPerMinute = 60,
		private readonly now: () => number = Date.now,
		private readonly maxKeys = 10_000,
	) {}

	/** null to drop; otherwise how many were suppressed since the last one recorded. */
	take(key: string): { suppressed: number } | null {
		const now = this.now();
		if (now - this.minuteStart >= 60_000) {
			this.minuteStart = now;
			this.inMinute = 0;
		}
		const last = this.lastByKey.get(key);
		if ((last !== undefined && now - last < this.perKeyWindowMs) || this.inMinute >= this.maxPerMinute) {
			this.suppressed++;
			return null;
		}
		if (this.lastByKey.size >= this.maxKeys) {
			for (const [k, at] of this.lastByKey) if (now - at >= this.perKeyWindowMs) this.lastByKey.delete(k);
			if (this.lastByKey.size >= this.maxKeys) this.lastByKey.clear();
		}
		this.lastByKey.set(key, now);
		this.inMinute++;
		const suppressed = this.suppressed;
		this.suppressed = 0;
		return { suppressed };
	}
}
