// Helpers shared by the operations console controllers: query parameters outside the list helper, error answers,
// search execution, people summaries, and the notes, audit entries and events shown on every detail page.
import type { Request, Response } from "express";
import mongoose from "mongoose";
import UserModel from "../../dal/models/user.model";
import AdminNoteModel, { type NoteTargetType } from "../../dal/models/adminNote.model";
import AuditLogModel from "../../dal/models/auditLog.model";
import EventModel from "../../dal/models/event.model";
import { ListQueryError } from "../../lib/listQuery";
import { SEARCH_COLLATION, SearchQueryError, type SearchQuery } from "../../lib/adminSearch";
import { TimeZoneError } from "../../lib/operations";
import { hasPermission, type Permission } from "../../config/adminPermissions";
// Declares req.admin (and loads the admin check every route here runs first).
import "../../middleware/verifyAdminJWT";
import log from "../../lib/logger";

/** Detail pages and searches answer within this. */
export const DETAIL_TIME_LIMIT_MS = 5000;
export const SEARCH_TIME_LIMIT_MS = 2000;

/** 400 for bad query input, 500 (logged) for anything else. */
export const answerError = (res: Response, error: unknown, what: string) => {
	if (error instanceof ListQueryError) return res.status(400).json({ message: error.message, field: error.field });
	if (error instanceof SearchQueryError) return res.status(400).json({ message: error.message, field: "q" });
	if (error instanceof TimeZoneError) return res.status(400).json({ message: error.message, field: "tz" });
	log.error("exception", `Error ${what}`, error);
	return res.status(500).json({ message: "Internal server error" });
};

/**
 * Takes parameters the list helper does not handle (search, joins) out of the query, each a single string or absent.
 * The rest goes to parseListQuery, which refuses anything unknown.
 */
export const takeParams = (query: Record<string, unknown>, names: readonly string[]) => {
	const rest: Record<string, unknown> = { ...query };
	const values: Record<string, string | undefined> = {};
	for (const name of names) {
		const value = rest[name];
		delete rest[name];
		if (value === undefined || value === "") continue;
		if (typeof value !== "string") throw new ListQueryError(`${name} must be given once, as text.`, name);
		values[name] = value;
	}
	return { rest, values };
};

export const booleanParam = (value: string | undefined, name: string): boolean | undefined => {
	if (value === undefined) return undefined;
	if (value !== "true" && value !== "false") throw new ListQueryError(`${name} must be true or false.`, name);
	return value === "true";
};

export const enumParam = <T extends string>(value: string | undefined, name: string, allowed: readonly T[]) => {
	if (value === undefined) return undefined;
	if (!(allowed as readonly string[]).includes(value)) {
		throw new ListQueryError(`${name} must be one of: ${allowed.join(", ")}.`, name);
	}
	return value as T;
};

/** Runs each search query (collation when it asks), merges by id in order, at most `limit` documents. */
export const runSearch = async <T extends { _id: unknown }>(
	model: mongoose.Model<any>,
	queries: SearchQuery[],
	options: { limit: number; projection?: string; sort?: Record<string, 1 | -1> },
): Promise<T[]> => {
	if (!queries.length) return [];
	const results = await Promise.all(
		queries.map((query) => {
			let cursor = model.find(query.filter, options.projection).limit(options.limit);
			if (options.sort) cursor = cursor.sort(options.sort);
			if (query.collation) cursor = cursor.collation(SEARCH_COLLATION);
			return cursor.maxTimeMS(SEARCH_TIME_LIMIT_MS).lean().exec() as Promise<T[]>;
		}),
	);
	const seen = new Set<string>();
	const merged: T[] = [];
	for (const doc of results.flat()) {
		const id = String(doc._id);
		if (seen.has(id)) continue;
		seen.add(id);
		merged.push(doc);
		if (merged.length >= options.limit) break;
	}
	return merged;
};

export const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));

export const PERSON_FIELDS = "firstName lastName email phone roles providerStatus suspended";

/** A customer or provider as the operations screens show them inside other records. */
export const personSummary = (user: any) =>
	user
		? {
				_id: String(user._id),
				firstName: user.firstName,
				lastName: user.lastName,
				name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
				email: user.email,
				phone: user.phone ?? null,
				role: user.roles?.Provider ? "provider" : "customer",
				providerStatus: user.roles?.Provider ? (user.providerStatus ?? null) : null,
				suspended: !!user.suspended,
			}
		: null;

/** People by id, for decorating list rows. */
export const loadPeople = async (ids: unknown[]) => {
	const unique = [...new Set(ids.filter(Boolean).map(String))];
	if (!unique.length) return new Map<string, ReturnType<typeof personSummary>>();
	const users = await UserModel.find({ _id: { $in: unique.map(oid) } }, PERSON_FIELDS)
		.maxTimeMS(DETAIL_TIME_LIMIT_MS)
		.lean()
		.exec();
	return new Map(users.map((user) => [String(user._id), personSummary(user)]));
};

export const publicNote = (note: any) => ({
	_id: String(note._id),
	targetType: note.targetType,
	targetId: String(note.targetId),
	body: note.body,
	author: { id: String(note.author?.id ?? ""), email: note.author?.email ?? null },
	createdAt: note.createdAt,
	updatedAt: note.updatedAt,
	editedAt: note.editedAt ?? null,
});

/** The notes on a record, newest first (deleted ones left out). */
export const notesFor = async (targetType: NoteTargetType, targetId: unknown) =>
	(
		await AdminNoteModel.find({ targetType, targetId: oid(targetId), deletedAt: null })
			.sort({ createdAt: -1 })
			.limit(100)
			.maxTimeMS(DETAIL_TIME_LIMIT_MS)
			.lean()
			.exec()
	).map(publicNote);

/** Audit entries about a record, newest first. Only for admins who may read the audit log. */
export const auditFor = async (req: Request, targetType: string, targetId: unknown, limit = 50) => {
	if (!req.admin || !hasPermission(req.admin, "audit.read")) return null;
	return AuditLogModel.find({ "target.type": targetType, "target.id": String(targetId) })
		.sort({ at: -1 })
		.limit(limit)
		.maxTimeMS(DETAIL_TIME_LIMIT_MS)
		.lean()
		.exec();
};

/** Business events with any of the given subject ids, newest first. */
export const eventsFor = async (subjects: Partial<Record<string, unknown>>, limit = 50) => {
	const clauses = Object.entries(subjects)
		.filter(([, value]) => value)
		.map(([field, value]) => ({ [field]: oid(value) }));
	if (!clauses.length) return [];
	const events = await EventModel.find(clauses.length === 1 ? clauses[0] : { $or: clauses })
		.sort({ at: -1 })
		.limit(limit)
		.maxTimeMS(DETAIL_TIME_LIMIT_MS)
		.lean()
		.exec();
	return events.map(publicEvent);
};

/** An event for the console: what, when, who, about what. Context (address, device) is left to observability. */
export const publicEvent = (event: any) => ({
	_id: String(event._id),
	type: event.type,
	at: event.at,
	actor: event.actor,
	userId: event.userId ? String(event.userId) : undefined,
	providerId: event.providerId ? String(event.providerId) : undefined,
	bookingId: event.bookingId ? String(event.bookingId) : undefined,
	paymentId: event.paymentId ? String(event.paymentId) : undefined,
	payoutId: event.payoutId ? String(event.payoutId) : undefined,
	applicationId: event.applicationId ? String(event.applicationId) : undefined,
	earningId: event.earningId ? String(event.earningId) : undefined,
	properties: event.properties ?? {},
	source: event.source,
});

export const can = (req: Request, permission: Permission) => !!req.admin && hasPermission(req.admin, permission);

/** Settles a promise within `ms`, else resolves to `fallback` (for optional calls to Stripe on a detail page). */
export const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise.catch(() => fallback),
		new Promise<T>((resolve) => {
			timer = setTimeout(() => resolve(fallback), ms);
		}),
	]).finally(() => timer && clearTimeout(timer));
};
