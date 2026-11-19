// Error tracking. Server errors (5xx answers, with the error that was logged while handling them, and errors logged
// outside any request) and client reports are fingerprinted and buffered in memory; a flush every 10 seconds upserts
// one document per group, adds exact hourly counts and writes sampled occurrences. Capturing never throws and never
// waits on the database. A resolved group reopens when it recurs in a newer revision.
import { EventSampler } from "../events";
import { culpritOf, fingerprintOf, revisionNumber } from "./fingerprint";
import { scrubRoute, scrubText } from "./scrub";

export interface CaptureInput {
	source: "server" | "client";
	platform?: string | null;
	type?: string | null;
	message?: string | null;
	stack?: string | null;
	route?: string | null;
	method?: string | null;
	status?: number | null;
	requestId?: string | null;
	trace?: string | null;
	userId?: string | null;
	adminId?: string | null;
	appVersion?: string | null;
	deviceId?: string | null;
	userAgent?: string | null;
	revision: string;
	at?: Date;
}

export interface PendingGroup {
	fingerprint: string;
	source: "server" | "client";
	platform: string;
	type: string;
	title: string;
	message: string;
	culprit: string | null;
	route: string | null;
	count: number;
	users: Set<string>;
	appVersions: Set<string>;
	lastAppVersion: string | null;
	firstAt: Date;
	lastAt: Date;
	revision: string;
}

export interface Occurrence {
	fingerprint: string;
	at: Date;
	source: "server" | "client";
	message: string;
	stack: string | null;
	route: string | null;
	method: string | null;
	status: number | null;
	requestId: string | null;
	trace: string | null;
	userId: string | null;
	adminId: string | null;
	platform: string | null;
	appVersion: string | null;
	deviceId: string | null;
	revision: string | null;
	userAgent: string | null;
}

const MAX_GROUPS_PENDING = 500;
const MAX_OCCURRENCES_PENDING = 300;

/** Pure: a capture turned into its scrubbed group fields and occurrence. */
export const prepareCapture = (input: CaptureInput) => {
	const at = input.at ?? new Date();
	const type = scrubText(input.type || (input.status ? `HTTP ${input.status}` : "Error"), 80);
	const message = scrubText(input.message || "", 1000);
	const stack = input.stack ? scrubText(input.stack, 8000) : null;
	const route = input.source === "client" ? scrubRoute(input.route) : (input.route ?? null);
	const platform = input.source === "server" ? "server" : (input.platform ?? "web");
	const fingerprint = fingerprintOf({ source: input.source, type, message, stack, route, platform });
	const firstLine =
		message.split("\n")[0] || (input.status ? `${input.method ?? ""} ${route ?? ""}`.trim() : "Unknown error");
	const title = `${type}: ${firstLine}`.slice(0, 200);
	const occurrence: Occurrence = {
		fingerprint,
		at,
		source: input.source,
		message,
		stack,
		route,
		method: input.method ?? null,
		status: input.status ?? null,
		requestId: input.requestId ?? null,
		trace: input.trace ?? null,
		userId: input.userId ?? null,
		adminId: input.adminId ?? null,
		platform,
		appVersion: input.appVersion ?? null,
		deviceId: input.deviceId ?? null,
		revision: input.revision,
		userAgent: input.userAgent ? scrubText(input.userAgent, 300) : null,
	};
	return { fingerprint, type, title, message, culprit: culpritOf(stack), route, platform, at, occurrence };
};

const lit = (value: unknown) => ({ $literal: value });

/**
 * The upsert pipeline for one pending group: counts and sets merged with what is stored, first-seen values kept, and
 * a resolved group reopened when this occurrence comes from a newer revision than the one it was resolved in.
 */
export const groupUpdate = (group: PendingGroup, retentionMs: number, now = new Date()) => {
	const current = revisionNumber(group.revision);
	const differentRevision = { $ne: [{ $ifNull: ["$resolvedInRevision", null] }, lit(group.revision)] };
	const newer =
		current === null
			? differentRevision
			: {
					$and: [
						differentRevision,
						{
							$or: [
								{ $eq: [{ $ifNull: ["$resolvedRevisionNumber", null] }, null] },
								{ $lt: ["$resolvedRevisionNumber", current] },
							],
						},
					],
				};
	const reopen = { $and: [{ $eq: ["$status", "resolved"] }, newer] };
	return [
		{ $set: { _reopen: reopen } },
		{
			$set: {
				fingerprint: lit(group.fingerprint),
				source: lit(group.source),
				platform: lit(group.platform),
				type: lit(group.type),
				title: lit(group.title),
				message: lit(group.message),
				culprit: lit(group.culprit),
				route: { $ifNull: ["$route", lit(group.route)] },
				status: { $cond: ["$_reopen", "unresolved", { $ifNull: ["$status", "unresolved"] }] },
				count: { $add: [{ $ifNull: ["$count", 0] }, group.count] },
				users: { $slice: [{ $setUnion: [{ $ifNull: ["$users", []] }, lit([...group.users])] }, 200] },
				appVersions: {
					$slice: [{ $setUnion: [{ $ifNull: ["$appVersions", []] }, lit([...group.appVersions])] }, 50],
				},
				lastAppVersion: group.lastAppVersion
					? lit(group.lastAppVersion)
					: { $ifNull: ["$lastAppVersion", null] },
				firstSeenAt: { $ifNull: ["$firstSeenAt", group.firstAt] },
				lastSeenAt: { $max: [{ $ifNull: ["$lastSeenAt", group.lastAt] }, group.lastAt] },
				firstRevision: { $ifNull: ["$firstRevision", lit(group.revision)] },
				lastRevision: lit(group.revision),
				statusChangedAt: { $cond: ["$_reopen", now, { $ifNull: ["$statusChangedAt", null] }] },
				statusChangedBy: { $cond: ["$_reopen", null, { $ifNull: ["$statusChangedBy", null] }] },
				resolvedInRevision: { $cond: ["$_reopen", null, { $ifNull: ["$resolvedInRevision", null] }] },
				resolvedRevisionNumber: { $cond: ["$_reopen", null, { $ifNull: ["$resolvedRevisionNumber", null] }] },
				reopenedAt: { $cond: ["$_reopen", now, { $ifNull: ["$reopenedAt", null] }] },
				reopenCount: { $add: [{ $ifNull: ["$reopenCount", 0] }, { $cond: ["$_reopen", 1, 0] }] },
				expireAt: new Date(group.lastAt.getTime() + retentionMs),
			},
		},
		{ $set: { userCount: { $size: "$users" } } },
		{ $unset: "_reopen" },
	];
};

export class ErrorBuffer {
	readonly groups = new Map<string, PendingGroup>();
	occurrences: Occurrence[] = [];
	dropped = 0;
	// The first occurrence of each group per minute is kept, at most 120 a minute in this instance.
	private readonly sampler: EventSampler;

	constructor(now: () => number = Date.now) {
		this.sampler = new EventSampler(60_000, 120, now);
	}

	add(input: CaptureInput) {
		const prepared = prepareCapture(input);
		let group = this.groups.get(prepared.fingerprint);
		if (!group) {
			if (this.groups.size >= MAX_GROUPS_PENDING) {
				this.dropped++;
				return prepared.fingerprint;
			}
			group = {
				fingerprint: prepared.fingerprint,
				source: input.source,
				platform: prepared.platform,
				type: prepared.type,
				title: prepared.title,
				message: prepared.message,
				culprit: prepared.culprit,
				route: prepared.route,
				count: 0,
				users: new Set(),
				appVersions: new Set(),
				lastAppVersion: null,
				firstAt: prepared.at,
				lastAt: prepared.at,
				revision: input.revision,
			};
			this.groups.set(prepared.fingerprint, group);
		}
		group.count++;
		group.lastAt = prepared.at > group.lastAt ? prepared.at : group.lastAt;
		// Customers and providers by id; admins prefixed, so the console links only the former to their pages.
		const person = input.userId ?? (input.adminId ? `admin:${input.adminId}` : null);
		if (person && group.users.size < 200) group.users.add(person);
		if (input.appVersion) {
			if (group.appVersions.size < 50) group.appVersions.add(input.appVersion);
			group.lastAppVersion = input.appVersion;
		}
		if (this.occurrences.length < MAX_OCCURRENCES_PENDING && this.sampler.take(prepared.fingerprint)) {
			this.occurrences.push(prepared.occurrence);
		}
		return prepared.fingerprint;
	}

	drain() {
		const groups = [...this.groups.values()];
		const occurrences = this.occurrences;
		this.groups.clear();
		this.occurrences = [];
		return { groups, occurrences };
	}
}
