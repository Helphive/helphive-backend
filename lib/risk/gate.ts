// Block and allow lists at sign-up, sign-in and booking creation. The active entries are held in memory and
// reloaded every 60 seconds (and at once on this instance after an admin changes a list), so the check in the request
// path is an in-memory lookup: no database query, except one indexed user read at booking creation when the block
// list holds phone numbers. If the lists cannot be loaded the gate lets requests through (fail open) and logs it.
import type { NextFunction, Request, Response } from "express";
import { validationResult } from "express-validator";
import { RiskListModel } from "../../dal/models/risk.model";
import UserModel from "../../dal/models/user.model";
import { isDemoAccountEmail } from "../../config/demoAccounts";
import { emitEvent } from "../events";
import log from "../logger";
import { decideLists, indexEntries, type ListEntry, type ListIndex } from "./lists";

export const LIST_CACHE_TTL_MS = 60_000;

/** What a blocked person is told: nothing about which list or why. */
export const BLOCKED_BODY = {
	message: "We can't complete this request. Contact HelpHive support if you need help.",
	code: "request_blocked",
} as const;

export type GatePoint = "signup" | "signin" | "booking";

/** 423 at sign-in (as for a suspended account: the installed app reads 403 there as "verify your email"). */
export const blockedStatus = (point: GatePoint) => (point === "signin" ? 423 : 403);

interface ListCache {
	at: number;
	index: ListIndex;
	size: number;
	hasPhoneBlocks: boolean;
}

let cache: ListCache = { at: 0, index: indexEntries([], Date.now()), size: 0, hasPhoneBlocks: false };
let loading: Promise<ListCache> | null = null;

export const entryFromDocument = (doc: any): ListEntry => ({
	id: String(doc._id),
	list: doc.list,
	kind: doc.kind,
	value: doc.value,
	expiresAt: doc.expiresAt ?? null,
	removedAt: doc.removedAt ?? null,
});

const load = async (): Promise<ListCache> => {
	const now = Date.now();
	const docs = await RiskListModel.find(
		{ removedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date(now) } }] },
		"list kind value expiresAt removedAt",
	)
		.limit(50_000)
		.maxTimeMS(3000)
		.lean()
		.exec();
	const entries = docs.map(entryFromDocument);
	return {
		at: now,
		index: indexEntries(entries, now),
		size: entries.length,
		hasPhoneBlocks: entries.some((e) => e.list === "block" && e.kind === "phone"),
	};
};

/** The active entries, reloaded when older than a minute. Keeps the last good copy if a reload fails. */
export const getListIndex = async (): Promise<ListCache> => {
	if (Date.now() - cache.at < LIST_CACHE_TTL_MS) return cache;
	loading ??= load()
		.then((fresh) => (cache = fresh))
		.catch((error) => {
			log.error("Risk: could not load the block and allow lists; requests are let through", error);
			cache = { ...cache, at: Date.now() - LIST_CACHE_TTL_MS + 10_000 }; // Retry in 10 s.
			return cache;
		})
		.finally(() => {
			loading = null;
		});
	return loading;
};

export const invalidateLists = () => {
	cache = { ...cache, at: 0 };
};

const countMatches = (ids: string[]) => {
	if (!ids.length) return;
	RiskListModel.updateMany({ _id: { $in: ids } }, { $inc: { matches: 1 }, $set: { lastMatchedAt: new Date() } })
		.exec()
		.catch((error) => log.error("Risk: could not count list matches", error));
};

/**
 * Express middleware. Mount after the route's validators: a request that failed validation goes through so the
 * handler answers it as before. Shared demo accounts are never blocked.
 */
export const riskListGate = (point: GatePoint) => async (req: Request, res: Response, next: NextFunction) => {
	try {
		if (!validationResult(req).isEmpty()) return next();
		const lists = await getListIndex();
		if (!lists.size) return next();
		const email = point === "booking" ? (req as Request & { user?: string }).user : req.body?.email;
		if (typeof email === "string" && isDemoAccountEmail(email)) return next();
		let phone: string | null = point === "signup" && typeof req.body?.phone === "string" ? req.body.phone : null;
		if (point === "booking" && lists.hasPhoneBlocks && typeof email === "string") {
			phone = ((await UserModel.findOne({ email }, "phone").maxTimeMS(2000).lean().exec()) as any)?.phone ?? null;
		}
		const decision = decideLists(lists.index, {
			email: typeof email === "string" ? email : null,
			phone,
			ip: req.context?.ip ?? req.ip,
			deviceId: req.context?.deviceId,
		});
		if (!decision.blocked) {
			if (decision.block.length) countMatches(decision.allow.map((m) => m.entry.id));
			return next();
		}
		countMatches(decision.block.map((m) => m.entry.id));
		emitEvent(
			{
				type: "risk.attempt_blocked",
				actor: { type: "anonymous" },
				properties: {
					point,
					kinds: [...new Set(decision.block.map((m) => m.entry.kind))],
					entryIds: decision.block.map((m) => m.entry.id).slice(0, 5),
				},
			},
			req,
		);
		return res.status(blockedStatus(point)).json(BLOCKED_BODY);
	} catch (error) {
		log.error(`Risk: the ${point} list check failed; the request was let through`, error);
		return next();
	}
};
