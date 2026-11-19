// The risk engine: loads the records around a person, computes the signals, evaluates the rules, stores the
// explained score and the hits, and carries out the actions of rules in enforce mode. It runs in this process, off
// the request path: business events are handed to it after they are written (lib/events.ts onEventRecorded), queued
// per person, and evaluated one at a time. A slow or failing evaluation is logged and never reaches a request.
import mongoose from "mongoose";
import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import PayoutModel from "../../dal/models/payout.model";
import EventModel from "../../dal/models/event.model";
import {
	RiskCaseModel,
	RiskChargeModel,
	RiskHitModel,
	RiskObservationModel,
	RiskRuleModel,
	RiskScoreModel,
} from "../../dal/models/risk.model";
import { SEARCH_COLLATION } from "../adminSearch";
import { emitEvent, onEventRecorded } from "../events";
import { recordAudit } from "../audit";
import { suspendUpdate } from "../suspension";
import { isDemoAccountEmail } from "../../config/demoAccounts";
import log from "../logger";
import {
	computeSignals,
	distanceKm,
	emptyDataset,
	indexDataset,
	isUsablePosition,
	type RiskBooking,
	type RiskCharge,
	type RiskDataset,
	type RiskEvent,
	type RiskObservation,
	type RiskPayment,
	type RiskPayout,
	type RiskUser,
} from "./signals";
import {
	DEFAULT_RULES,
	defaultRuleDocuments,
	evaluateRule,
	explainScore,
	maxSeverity,
	plannedActions,
	type RuleDefinition,
	type RuleHit,
	type Severity,
} from "./rules";
import { TRIGGER_EVENT_TYPES, peopleOf, utcDay } from "./backtest";
import { linksFromIndex, type Link } from "./graph";
import { decideLists, normalizePhone } from "./lists";
import { getListIndex } from "./gate";
import { placeHold } from "./holds";

const DAY = 24 * 60 * 60 * 1000;
const QUERY_TIME_LIMIT_MS = 5000;
const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));
const str = (id: unknown) => (id ? String(id) : undefined);
const time = (value: unknown) => (value ? new Date(value as string).getTime() : null);

// --- Converting records ------------------------------------------------------------------------------------------

export const toRiskEvent = (doc: any): RiskEvent => ({
	id: String(doc._id),
	type: doc.type,
	at: new Date(doc.at).getTime(),
	actorType: doc.actor?.type,
	actorId: str(doc.actor?.id),
	userId: str(doc.userId),
	providerId: str(doc.providerId),
	bookingId: str(doc.bookingId),
	paymentId: str(doc.paymentId),
	payoutId: str(doc.payoutId),
	ip: doc.context?.ip,
	deviceId: doc.context?.deviceId,
	properties: doc.properties ?? {},
});

export const toRiskUser = (doc: any): RiskUser => ({
	id: String(doc._id),
	createdAt: time(doc.createdAt),
	isProvider: !!doc.roles?.Provider,
	phone: doc.phone ?? null,
	sessionDevices: (doc.sessions ?? []).map((s: any) => s.deviceId).filter(Boolean),
	sessionIps: (doc.sessions ?? []).map((s: any) => s.lastIp).filter(Boolean),
});

export const toRiskBooking = (doc: any): RiskBooking => ({
	id: String(doc._id),
	userId: String(doc.userId),
	providerId: str(doc.providerId) ?? null,
	amount: Math.round((Number(doc.rate) || 0) * (Number(doc.hours) || 0) * 100) / 100,
	hours: Number(doc.hours) || 0,
	status: doc.status,
	createdAt: time(doc.createdAt) ?? 0,
	acceptedAt: time(doc.acceptedAt),
	startedAt: time(doc.startedAt),
	completedAt: time(doc.completedAt),
	cancelledAt: time(doc.cancelledAt),
	cancelledBy: str(doc.cancelledBy) ?? null,
	address: doc.address ?? null,
});

export const toRiskPayment = (doc: any): RiskPayment => ({
	id: String(doc._id),
	bookingId: String(doc.bookingId),
	amount: Number(doc.amount) || 0,
	status: doc.status,
	createdAt: time(doc.createdAt) ?? 0,
	refundAt: doc.refundId
		? time(doc.refundCreated)
		: time(doc.refunds?.[0]?.createdAt ?? doc.refunds?.[0]?.requestedAt),
});

export const payoutDestinationKey = (details: any) =>
	details?.last4 ? `${details.type ?? "unknown"}|${details.last4}|${(details.country ?? "").toUpperCase()}` : null;

export const toRiskPayout = (doc: any): RiskPayout => ({
	id: String(doc._id),
	providerId: String(doc.userId),
	amount: Number(doc.amount) || 0,
	createdAt: time(doc.createdAt) ?? 0,
	destination: payoutDestinationKey(doc.destinationDetails),
});

export const toRiskCharge = (doc: any): RiskCharge => ({
	id: String(doc._id),
	paymentId: str(doc.paymentId) ?? null,
	bookingId: str(doc.bookingId) ?? null,
	userId: str(doc.userId) ?? null,
	at: new Date(doc.at).getTime(),
	status: doc.status,
	riskLevel: doc.outcome?.riskLevel ?? null,
	riskScore: typeof doc.outcome?.riskScore === "number" ? doc.outcome.riskScore : null,
	outcomeType: doc.outcome?.type ?? null,
	card: doc.card?.fingerprint ?? null,
});

export const toRiskObservation = (doc: any): RiskObservation => ({
	id: String(doc._id),
	kind: doc.kind,
	bookingId: String(doc.bookingId),
	providerId: String(doc.providerId),
	at: new Date(doc.at).getTime(),
	distanceKm: doc.distanceKm,
	fixAgeMs: doc.fixAgeMs,
});

const USER_FIELDS = "createdAt roles phone email sessions.deviceId sessions.lastIp";
const EVENT_FIELDS =
	"type at actor userId providerId bookingId paymentId payoutId context.ip context.deviceId properties";

// --- Phone numbers: an in-memory index (users store phones as typed, so they cannot be matched by a query) -------

let phoneIndex: { at: number; byKey: Map<string, string[]> } | null = null;
let phoneLoad: Promise<Map<string, string[]>> | null = null;
const PHONE_INDEX_TTL_MS = 10 * 60 * 1000;

const phoneOwners = async (): Promise<Map<string, string[]>> => {
	if (phoneIndex && Date.now() - phoneIndex.at < PHONE_INDEX_TTL_MS) return phoneIndex.byKey;
	phoneLoad ??= (async () => {
		try {
			const users = await UserModel.find({ phone: { $nin: [null, ""] } }, "phone")
				.maxTimeMS(QUERY_TIME_LIMIT_MS)
				.lean()
				.exec();
			const byKey = new Map<string, string[]>();
			for (const user of users) {
				const key = normalizePhone(user.phone);
				if (!key) continue;
				byKey.set(key, [...(byKey.get(key) ?? []), String(user._id)]);
			}
			phoneIndex = { at: Date.now(), byKey };
			return byKey;
		} finally {
			phoneLoad = null;
		}
	})();
	return phoneLoad;
};

// --- Loading a dataset around one person ------------------------------------------------------------------------

/** At most this many of each record kind per load, so one very active account cannot make an evaluation heavy. */
export const LOAD_LIMIT = 3000;

/**
 * The person's own events (90 days), events from the same devices and addresses, their bookings (180 days) and
 * bookings at the same addresses, payments, payouts and payouts to the same bank details, Stripe assessments,
 * position checks, and the accounts sharing their phone number. About ten indexed queries.
 */
export const loadUserDataset = async (userId: string, asOf = Date.now()): Promise<RiskDataset | null> => {
	const uid = oid(userId);
	const user: any = await UserModel.findById(uid, USER_FIELDS).maxTimeMS(QUERY_TIME_LIMIT_MS).lean().exec();
	if (!user) return null;
	const upTo = new Date(asOf);
	const since = (days: number) => new Date(asOf - days * DAY);
	const limit = <T>(query: mongoose.Query<T, any>) => query.maxTimeMS(QUERY_TIME_LIMIT_MS).lean().exec();

	const [own, bookings, payouts, charges, observations, phones] = await Promise.all([
		limit(
			EventModel.find(
				{
					$or: [{ userId: uid }, { providerId: uid }, { "actor.id": String(uid) }],
					at: { $gte: since(90), $lte: upTo },
				},
				EVENT_FIELDS,
			)
				.sort({ at: -1 })
				.limit(LOAD_LIMIT),
		),
		limit(
			BookingModel.find({
				$or: [{ userId: uid }, { providerId: uid }],
				createdAt: { $gte: since(180), $lte: upTo },
			})
				.sort({ createdAt: -1 })
				.limit(1000),
		),
		limit(
			PayoutModel.find({ userId: uid, createdAt: { $lte: upTo } })
				.sort({ createdAt: 1 })
				.limit(500),
		),
		limit(RiskChargeModel.find({ userId: uid, at: { $gte: since(30), $lte: upTo } }).limit(500)),
		limit(RiskObservationModel.find({ providerId: uid, at: { $gte: since(30), $lte: upTo } }).limit(500)),
		phoneOwners(),
	]);

	const ownEvents = (own as any[]).map(toRiskEvent);
	const devices = new Set<string>(user.sessions?.map((s: any) => s.deviceId).filter(Boolean) ?? []);
	const ips = new Set<string>(user.sessions?.map((s: any) => s.lastIp).filter(Boolean) ?? []);
	for (const event of ownEvents) {
		if ((event.actorId === userId || event.type === "auth.sign_in_failed") && event.deviceId)
			devices.add(event.deviceId);
		if ((event.actorId === userId || event.type === "auth.sign_in_failed") && event.ip) ips.add(event.ip);
	}
	const customerAddresses = [
		...new Set(
			(bookings as any[])
				.filter((b) => String(b.userId) === userId)
				.map((b) => b.address)
				.filter(Boolean),
		),
	].slice(0, 50);
	const destinations = (payouts as any[]).map((p) => p.destinationDetails).filter((d) => d?.last4);
	const phoneKey = normalizePhone(user.phone);
	const phoneMates = phoneKey ? (phones.get(phoneKey) ?? []) : [];

	const [neighbours, addressBookings, destinationPayouts, mates] = await Promise.all([
		devices.size || ips.size
			? limit(
					EventModel.find(
						{
							$or: [
								...(devices.size ? [{ "context.deviceId": { $in: [...devices].slice(0, 50) } }] : []),
								...(ips.size ? [{ "context.ip": { $in: [...ips].slice(0, 50) } }] : []),
							],
							at: { $gte: since(90), $lte: upTo },
						},
						EVENT_FIELDS,
					)
						.sort({ at: -1 })
						.limit(LOAD_LIMIT),
				)
			: Promise.resolve([]),
		customerAddresses.length
			? BookingModel.find({ address: { $in: customerAddresses }, createdAt: { $gte: since(180), $lte: upTo } })
					.collation(SEARCH_COLLATION)
					.limit(1000)
					.maxTimeMS(QUERY_TIME_LIMIT_MS)
					.lean()
					.exec()
			: Promise.resolve([]),
		destinations.length
			? limit(
					PayoutModel.find({
						"destinationDetails.last4": { $in: destinations.map((d: any) => d.last4) },
						createdAt: { $lte: upTo },
					}).limit(500),
				)
			: Promise.resolve([]),
		phoneMates.length
			? limit(UserModel.find({ _id: { $in: phoneMates.slice(0, 50).map(oid) } }, USER_FIELDS))
			: Promise.resolve([]),
	]);

	const allBookings = new Map<string, any>();
	for (const b of [...(bookings as any[]), ...(addressBookings as any[])]) allBookings.set(String(b._id), b);
	const ownBookingIds = (bookings as any[]).map((b) => b._id);
	const payments = ownBookingIds.length
		? await limit(PaymentModel.find({ bookingId: { $in: ownBookingIds } }).limit(LOAD_LIMIT))
		: [];

	const events = new Map<string, RiskEvent>();
	for (const event of [...ownEvents, ...(neighbours as any[]).map(toRiskEvent)]) events.set(event.id, event);
	const users = new Map<string, RiskUser>([[userId, toRiskUser(user)]]);
	for (const mate of mates as any[]) users.set(String(mate._id), toRiskUser(mate));

	return {
		users: [...users.values()],
		events: [...events.values()],
		bookings: [...allBookings.values()].map(toRiskBooking),
		payments: (payments as any[]).map(toRiskPayment),
		payouts: [
			...new Map(
				[...(payouts as any[]), ...(destinationPayouts as any[])].map((p) => [String(p._id), p]),
			).values(),
		]
			.map(toRiskPayout)
			.filter(
				(p) =>
					p.providerId === userId || destinations.some((d: any) => payoutDestinationKey(d) === p.destination),
			),
		charges: (charges as any[]).map(toRiskCharge),
		observations: (observations as any[]).map(toRiskObservation),
	};
};

/** Links from one person to others, for the linked-accounts graph. */
export const loadLinks = async (userId: string): Promise<Link[]> => {
	const ds = await loadUserDataset(userId);
	if (!ds) return [];
	return linksFromIndex(indexDataset(ds), userId, Date.now());
};

// --- Rules -------------------------------------------------------------------------------------------------------

let rulesCache: { at: number; rules: RuleDefinition[] } | null = null;
const RULES_TTL_MS = 30_000;

export const ruleFromDocument = (doc: any): RuleDefinition => ({
	key: doc.key,
	title: doc.title,
	explanation: doc.explanation ?? "",
	match: doc.match ?? "all",
	conditions: (doc.conditions ?? []).map((c: any) => ({ signal: c.signal, op: c.op, value: c.value })),
	weight: doc.weight,
	severity: doc.severity,
	actions: doc.actions ?? ["score"],
	mode: doc.mode,
});

export const activeRules = async (): Promise<RuleDefinition[]> => {
	if (rulesCache && Date.now() - rulesCache.at < RULES_TTL_MS) return rulesCache.rules;
	const docs = await RiskRuleModel.find({ mode: { $ne: "off" } })
		.maxTimeMS(QUERY_TIME_LIMIT_MS)
		.lean()
		.exec();
	rulesCache = { at: Date.now(), rules: docs.map(ruleFromDocument) };
	return rulesCache.rules;
};

/** After a rule changes on this instance; other instances pick it up within 30 s. */
export const invalidateRules = () => {
	rulesCache = null;
};

/** Inserts the default rules that are missing (by key). Never changes a rule an admin has edited. */
export const ensureDefaultRules = async () => {
	const result = await RiskRuleModel.bulkWrite(
		defaultRuleDocuments().map((doc) => ({
			updateOne: { filter: { key: doc.key }, update: { $setOnInsert: doc } as any, upsert: true },
		})),
		{ ordered: false },
	);
	if (result.upsertedCount) log.info(`Risk: added ${result.upsertedCount} default rules in observe mode.`);
	return result.upsertedCount;
};

// --- Evaluation --------------------------------------------------------------------------------------------------

export interface EvaluationTrigger {
	type: string;
	eventId?: string;
}

const SYSTEM_ACTOR = { type: "system" as const };

/** Opens a case about a subject, or adds to the active one. Returns the case and whether it was new. */
export const openOrUpdateCase = async (input: {
	subject: { type: "user" | "booking" | "payment" | "payout"; id: string };
	userId: string | null;
	title: string;
	severity: Severity;
	score: number;
	rules: string[];
	evidence: unknown[];
	linked?: { userIds?: string[]; bookingIds?: string[]; paymentIds?: string[]; payoutIds?: string[] };
	openedBy: { type: "rule" | "admin"; ruleKey?: string; adminId?: unknown };
	by: { type: string; id?: string; email?: string };
}) => {
	const now = new Date();
	const filter = { "subject.type": input.subject.type, "subject.id": oid(input.subject.id), active: true };
	const linked = input.linked ?? {};
	const existing = await RiskCaseModel.findOne(filter).exec();
	if (existing) {
		const newRules = input.rules.filter((r) => !existing.rules.includes(r));
		if (!newRules.length && existing.score === input.score) return { riskCase: existing, created: false };
		existing.rules = [...existing.rules, ...newRules];
		existing.evidence = [...((existing.evidence as unknown[]) ?? []), ...input.evidence].slice(-50);
		existing.score = input.score;
		existing.severity = maxSeverity([existing.severity as Severity, input.severity]);
		for (const kind of ["userIds", "bookingIds", "paymentIds", "payoutIds"] as const) {
			existing.linked![kind] = [...new Set([...(existing.linked?.[kind] ?? []), ...(linked[kind] ?? [])])].slice(
				0,
				100,
			);
		}
		existing.history.push({
			at: now,
			action: "rules_added",
			by: input.by,
			detail: { rules: newRules, score: input.score },
		});
		await existing.save();
		return { riskCase: existing, created: false };
	}
	try {
		const riskCase = await RiskCaseModel.create({
			subject: { type: input.subject.type, id: oid(input.subject.id) },
			userId: input.userId ? oid(input.userId) : null,
			title: input.title,
			status: "open",
			active: true,
			severity: input.severity,
			score: input.score,
			rules: input.rules,
			evidence: input.evidence,
			linked: {
				userIds: linked.userIds ?? [],
				bookingIds: linked.bookingIds ?? [],
				paymentIds: linked.paymentIds ?? [],
				payoutIds: linked.payoutIds ?? [],
			},
			openedBy: input.openedBy,
			history: [{ at: now, action: "opened", by: input.by, detail: { rules: input.rules } }],
		});
		return { riskCase, created: true };
	} catch (error: any) {
		if (error?.code !== 11000) throw error;
		return { riskCase: (await RiskCaseModel.findOne(filter).exec())!, created: false };
	}
};

const linkedFrom = (hits: RuleHit[]) => {
	const linked = {
		userIds: new Set<string>(),
		bookingIds: new Set<string>(),
		paymentIds: new Set<string>(),
		payoutIds: new Set<string>(),
	};
	for (const hit of hits) {
		for (const evidence of hit.evidence) {
			for (const kind of ["userIds", "bookingIds", "paymentIds", "payoutIds"] as const) {
				for (const id of evidence.refs?.[kind] ?? []) linked[kind].add(id);
			}
		}
	}
	return Object.fromEntries(Object.entries(linked).map(([k, v]) => [k, [...v].slice(0, 100)]));
};

/** Suspends an account for a rule in enforce mode: the same atomic update an admin's suspension makes. */
const suspendForRule = async (userId: string, hit: RuleHit) => {
	const reason = `Risk rule "${hit.title}" in enforce mode.`;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { suspendedBy, ...set } = suspendUpdate("system", reason, new Date()).$set;
	const before = await UserModel.findOneAndUpdate(
		{ _id: oid(userId), suspended: { $ne: true } },
		{ $set: set },
		{ new: false },
	).exec();
	if (!before) return false;
	if (before.roles?.Provider) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { closeProviderSocket } = require("../../controllers/user-controllers/provider-websocket");
		closeProviderSocket(before.email);
	}
	await recordAudit({
		action: "risk.user_suspended",
		actor: SYSTEM_ACTOR,
		target: { type: "user", id: userId },
		before: { suspended: false },
		after: { suspended: true },
		reason,
		metadata: { ruleKey: hit.ruleKey },
	});
	emitEvent({
		type: "user.suspended",
		actor: { type: "system" },
		subjects: { userId, ...(before.roles?.Provider ? { providerId: userId } : {}) },
		properties: { by: "risk_rule", ruleKey: hit.ruleKey },
	});
	return true;
};

export interface EvaluationResult {
	userId: string;
	score: number;
	band: Severity;
	hits: RuleHit[];
	newHits: string[];
	actionsTaken: string[];
	exempt: string | null;
}

/** Days after an admin clears a case during which rules do not act on that person again (they still score). */
export const CLEARED_GRACE_DAYS = 30;

/** Evaluates one person now: score and hits stored, enforce-mode actions carried out. */
export const evaluateUser = async (userId: string, trigger: EvaluationTrigger): Promise<EvaluationResult | null> => {
	const now = Date.now();
	const ds = await loadUserDataset(userId, now);
	if (!ds) return null;
	const user: any = await UserModel.findById(userId, "email phone roles sessions.deviceId").lean().exec();
	const subject = ds.users.find((u) => u.id === userId)!;

	// Allow lists exempt a person from rules.
	const lists = await getListIndex();
	const allowed = decideLists(lists.index, {
		email: user?.email,
		phone: user?.phone,
		deviceId: subject.sessionDevices?.[0],
	}).allow;
	const exempt = allowed.length ? `On the allow list (${allowed[0].entry.kind}).` : null;

	const rules = exempt ? [] : await activeRules();
	const index = indexDataset(ds);
	const signals = computeSignals(index, userId, now);
	const hits = rules.map((rule) => evaluateRule(rule, signals)).filter(Boolean) as RuleHit[];
	const explained = explainScore(hits);
	await RiskScoreModel.updateOne(
		{ userId: oid(userId) },
		{
			$set: {
				score: explained.score,
				band: explained.band,
				contributions: explained.contributions,
				signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, v.value])),
				explanation: exempt ?? explained.explanation,
				exempt,
				evaluatedAt: new Date(now),
				trigger,
			},
		},
		{ upsert: true },
	).exec();

	const day = utcDay(now);
	const demoAccount = isDemoAccountEmail(user?.email);
	const recentlyCleared = await RiskCaseModel.exists({
		userId: oid(userId),
		"decision.outcome": "cleared",
		"decision.at": { $gte: new Date(now - CLEARED_GRACE_DAYS * DAY) },
	});
	const newHits: RuleHit[] = [];
	for (const hit of hits) {
		const planned = plannedActions([hit]);
		const acts = hit.mode === "enforce" && !demoAccount && !recentlyCleared;
		try {
			await RiskHitModel.create({
				key: `${hit.ruleKey}|${userId}|${day}`,
				ruleKey: hit.ruleKey,
				userId: oid(userId),
				at: new Date(now),
				mode: hit.mode,
				severity: hit.severity,
				weight: hit.weight,
				actionsTaken: acts ? planned.take : [],
				actionsWouldTake: acts ? [] : [...planned.take, ...planned.wouldTake],
				evidence: hit.evidence,
				eventId: trigger.eventId,
			});
		} catch (error: any) {
			if (error?.code === 11000) continue; // Already recorded today.
			throw error;
		}
		newHits.push(hit);
		await RiskRuleModel.updateOne(
			{ key: hit.ruleKey },
			{ $inc: { hits: 1 }, $set: { lastFiredAt: new Date(now) } },
		).exec();
		emitEvent({
			type: "risk.rule_fired",
			actor: { type: "system" },
			subjects: { userId },
			properties: {
				ruleKey: hit.ruleKey,
				mode: hit.mode,
				severity: hit.severity,
				weight: hit.weight,
				enforced: acts,
			},
		});
	}

	// Actions of enforce-mode rules that newly fired (one per rule, person and day, so an admin's release sticks).
	const actionsTaken = new Set<string>();
	const enforced = newHits.filter((h) => h.mode === "enforce");
	if (enforced.length && !demoAccount && !recentlyCleared) {
		const take = plannedActions(enforced).take;
		const ruleKeys = enforced.map((h) => h.ruleKey);
		if (take.includes("open_case")) {
			const { riskCase, created } = await openOrUpdateCase({
				subject: { type: "user", id: userId },
				userId,
				title: enforced[0].title,
				severity: maxSeverity(enforced.map((h) => h.severity)),
				score: explained.score,
				rules: ruleKeys,
				evidence: enforced.map((h) => ({
					ruleKey: h.ruleKey,
					title: h.title,
					at: new Date(now),
					conditions: h.evidence,
				})),
				linked: linkedFrom(enforced),
				openedBy: { type: "rule", ruleKey: ruleKeys[0] },
				by: { type: "system" },
			});
			if (created) {
				actionsTaken.add("open_case");
				await recordAudit({
					action: "risk.case_opened",
					actor: SYSTEM_ACTOR,
					target: { type: "risk_case", id: riskCase._id },
					metadata: { rules: ruleKeys, subjectType: "user", userId },
				});
				emitEvent({
					type: "risk.case_opened",
					actor: { type: "system" },
					subjects: { userId },
					properties: {
						caseId: String(riskCase._id),
						severity: riskCase.severity,
						rules: ruleKeys,
						by: "rule",
					},
				});
			}
		}
		if (subject.isProvider) {
			for (const kind of ["hold_payouts", "review_before_payout"] as const) {
				if (!take.includes(kind)) continue;
				const rule = enforced.find((h) => h.actions.includes(kind))!;
				const { hold, created } = await placeHold({
					userId,
					kind: kind === "hold_payouts" ? "hold" : "review_before_payout",
					reason: `Risk rule "${rule.title}" fired.`,
					source: { type: "rule", ruleKey: rule.ruleKey },
				});
				if (!created) continue;
				actionsTaken.add(kind);
				await recordAudit({
					action: "risk.hold_placed",
					actor: SYSTEM_ACTOR,
					target: { type: "user", id: userId },
					after: { kind: hold.kind, active: true },
					reason: hold.reason,
					metadata: { holdId: String(hold._id), ruleKey: rule.ruleKey },
				});
				emitEvent({
					type: "risk.hold_placed",
					actor: { type: "system" },
					subjects: { userId, providerId: userId },
					properties: { holdId: String(hold._id), kind: hold.kind, by: "rule", ruleKey: rule.ruleKey },
				});
			}
		}
		if (take.includes("suspend")) {
			const rule = enforced.find((h) => h.actions.includes("suspend"))!;
			if (await suspendForRule(userId, rule)) actionsTaken.add("suspend");
		}
	}
	return {
		userId,
		score: explained.score,
		band: explained.band,
		hits,
		newHits: newHits.map((h) => h.ruleKey),
		actionsTaken: [...actionsTaken],
		exempt,
	};
};

// --- Positions at start and completion ---------------------------------------------------------------------------

/** Records how far the provider's last known position was from the booking when it started or completed. */
export const recordPositionCheck = async (event: RiskEvent) => {
	if (!event.bookingId || !event.providerId) return;
	const kind = event.type === "booking.started" ? "start" : "complete";
	const [booking, provider]: any[] = await Promise.all([
		BookingModel.findById(event.bookingId, "latitude longitude").lean().exec(),
		UserModel.findById(event.providerId, "currentLocation locationUpdatedAt").lean().exec(),
	]);
	const lat = provider?.currentLocation?.latitude;
	const lon = provider?.currentLocation?.longitude;
	if (!booking || !provider?.locationUpdatedAt || !isUsablePosition(lat, lon)) return;
	if (!isUsablePosition(booking.latitude, booking.longitude)) return;
	await RiskObservationModel.updateOne(
		{ key: `${kind}|${event.bookingId}` },
		{
			$setOnInsert: {
				kind,
				bookingId: oid(event.bookingId),
				providerId: oid(event.providerId),
				at: new Date(event.at),
				distanceKm: Math.round(distanceKm(lat, lon, booking.latitude, booking.longitude) * 100) / 100,
				fixAgeMs: Math.max(0, event.at - new Date(provider.locationUpdatedAt).getTime()),
			},
		},
		{ upsert: true },
	).exec();
};

// --- The queue -----------------------------------------------------------------------------------------------------

/** People waiting for evaluation; a second event for the same person before it runs is merged. */
const pending = new Map<string, EvaluationTrigger>();
let running = false;
let timer: NodeJS.Timeout | null = null;
export const MAX_PENDING = 1000;
/** Waits this long after an event so a burst (booking, payment, notification) is evaluated once. */
export const QUEUE_DELAY_MS = 2000;
const EVALUATION_TIMEOUT_MS = 20_000;

const drain = async () => {
	timer = null;
	if (running) return;
	running = true;
	try {
		while (pending.size) {
			const [userId, trigger] = pending.entries().next().value as [string, EvaluationTrigger];
			pending.delete(userId);
			try {
				await Promise.race([
					evaluateUser(userId, trigger),
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error("evaluation timed out")), EVALUATION_TIMEOUT_MS).unref(),
					),
				]);
			} catch (error) {
				log.error(`Risk evaluation failed for user ${userId}`, error);
			}
		}
	} finally {
		running = false;
	}
};

export const scheduleEvaluation = (userIds: string[], trigger: EvaluationTrigger) => {
	for (const userId of userIds) {
		if (!/^[a-f\d]{24}$/i.test(userId)) continue;
		if (!pending.has(userId) && pending.size >= MAX_PENDING) {
			log.warn("Risk evaluation queue is full; an evaluation was skipped.");
			continue;
		}
		pending.set(userId, trigger);
	}
	if (!timer && pending.size) {
		timer = setTimeout(() => void drain(), QUEUE_DELAY_MS);
		timer.unref?.();
	}
};

/** Hands a written event to the engine. Never throws. */
export const handleRecordedEvent = (doc: Record<string, unknown>) => {
	try {
		if (!TRIGGER_EVENT_TYPES.has(String(doc.type))) return;
		const event = toRiskEvent(doc);
		const trigger = { type: event.type, eventId: event.id };
		void (async () => {
			try {
				if (event.type === "booking.started" || event.type === "booking.completed")
					await recordPositionCheck(event);
				let people = peopleOf(event);
				if (!event.userId && event.bookingId) {
					const booking: any = await BookingModel.findById(event.bookingId, "userId").lean().exec();
					if (booking) people = [...new Set([...people, String(booking.userId)])];
				}
				scheduleEvaluation(people, trigger);
			} catch (error) {
				log.error(`Risk: could not handle event ${event.type}`, error);
			}
		})();
	} catch (error) {
		log.error("Risk: could not read a recorded event", error);
	}
};

let started = false;

/** Subscribes the engine to recorded events and adds the default rules once the database is connected. */
export const startRiskEngine = () => {
	if (started) return;
	started = true;
	onEventRecorded(handleRecordedEvent);
	const seed = () => ensureDefaultRules().catch((error) => log.error("Risk: could not add the default rules", error));
	if (mongoose.connection.readyState === 1) void seed();
	else mongoose.connection.once("open", () => void seed());
};

// --- Backtest dataset --------------------------------------------------------------------------------------------

export const BACKTEST_EVENT_LIMIT = 30_000;

/** Everything a backtest of [from, to] needs, loaded once, read only. */
export const loadPeriodDataset = async (from: number, to: number) => {
	const ds = emptyDataset();
	const window = { $gte: new Date(from - 30 * DAY), $lte: new Date(to) };
	const sorted = { at: 1 as const, _id: 1 as const };
	const [events, bookings, payouts, users, charges, observations] = await Promise.all([
		EventModel.find({ at: window }, EVENT_FIELDS)
			.sort(sorted)
			.limit(BACKTEST_EVENT_LIMIT)
			.maxTimeMS(20_000)
			.lean()
			.exec(),
		BookingModel.find({ createdAt: { $gte: new Date(from - 180 * DAY), $lte: new Date(to) } })
			.sort({ createdAt: 1, _id: 1 })
			.limit(20_000)
			.maxTimeMS(20_000)
			.lean()
			.exec(),
		PayoutModel.find({ createdAt: { $lte: new Date(to) } })
			.sort({ createdAt: 1, _id: 1 })
			.limit(20_000)
			.maxTimeMS(20_000)
			.lean()
			.exec(),
		UserModel.find({ createdAt: { $lte: new Date(to) } }, USER_FIELDS)
			.sort({ _id: 1 })
			.limit(50_000)
			.maxTimeMS(20_000)
			.lean()
			.exec(),
		RiskChargeModel.find({ at: window }).sort(sorted).limit(20_000).maxTimeMS(20_000).lean().exec(),
		RiskObservationModel.find({ at: window }).sort(sorted).limit(20_000).maxTimeMS(20_000).lean().exec(),
	]);
	const bookingIds = (bookings as any[]).map((b) => b._id);
	const payments = bookingIds.length
		? await PaymentModel.find({ bookingId: { $in: bookingIds } })
				.limit(20_000)
				.maxTimeMS(20_000)
				.lean()
				.exec()
		: [];
	ds.events = (events as any[]).map(toRiskEvent);
	ds.bookings = (bookings as any[]).map(toRiskBooking);
	ds.payments = (payments as any[]).map(toRiskPayment);
	ds.payouts = (payouts as any[]).map(toRiskPayout);
	ds.users = (users as any[]).map(toRiskUser);
	ds.charges = (charges as any[]).map(toRiskCharge);
	ds.observations = (observations as any[]).map(toRiskObservation);
	return { ds, truncated: events.length >= BACKTEST_EVENT_LIMIT };
};

export const DEFAULT_RULE_KEYS = DEFAULT_RULES.map((r) => r.key);
