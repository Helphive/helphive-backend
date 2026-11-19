// Customers and providers in one directory (users.read), and the account actions (users.manage): suspend, reinstate,
// end sessions, mark the email verified, resend the verification email, turn provider availability off.
import { Request, Response } from "express";
import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import PayoutModel from "../../dal/models/payout.model";
import ProviderApplicationModel from "../../dal/models/providerapplication.model";
import EventModel from "../../dal/models/event.model";
import stripe from "../service-accounts/stripe";
import { parseDateBound, parseListQuery, runListQuery, type ListSpec } from "../../lib/listQuery";
import { buildSearchPlan, isSearchable, userSearchQueries } from "../../lib/adminSearch";
import { EXPIRED_REASON, bookingReference, coarseLocation, roundMoney } from "../../lib/operations";
import { isSuspended, reinstateUpdate, suspendUpdate } from "../../lib/suspension";
import { getBookingDisplayStatus } from "../user-controllers/utils/booking.utils";
import { sendVerificationEmail } from "../email.controller";
import { closeProviderSocket } from "../user-controllers/provider-websocket";
import { isDemoAdmin } from "../../config/adminPermissions";
import { adminActor, recordAudit } from "../../lib/audit";
import { revokeAllChatTokens } from "../../lib/chat/chatTokens";
import { forgetAllPush } from "../user-controllers/utils/session.utils";
import { emitEvent } from "../../lib/events";
import {
	DETAIL_TIME_LIMIT_MS,
	answerError,
	auditFor,
	booleanParam,
	eventsFor,
	notesFor,
	oid,
	runSearch,
	takeParams,
	within,
} from "./operations.shared";

/** Search narrows a list to at most this many matching people. */
const SEARCH_MATCH_LIMIT = 200;

export const USER_LIST_SPEC: ListSpec = {
	sortable: {
		createdAt: "createdAt",
		lastName: "lastName",
		email: "email",
		lastActiveAt: "lastActiveAt",
		suspendedAt: "suspendedAt",
	},
	defaultSort: "-createdAt",
	filters: {
		role: {
			type: "custom",
			parse: (value) =>
				value === "customer"
					? { "roles.User": true }
					: value === "provider"
						? { "roles.Provider": true }
						: null,
		},
		providerStatus: {
			type: "enum",
			path: "providerStatus",
			values: ["inactive", "pending", "approved", "rejected"],
		},
		emailVerified: { type: "boolean", path: "isEmailVerified" },
		suspended: {
			type: "custom",
			parse: (value) =>
				value === "true" ? { suspended: true } : value === "false" ? { suspended: { $ne: true } } : null,
		},
		available: { type: "boolean", path: "isProviderAvailable" },
		activeFrom: {
			type: "custom",
			parse: (value) => ({ lastActiveAt: { $gte: parseDateBound(value, "activeFrom", false) } }),
		},
		activeTo: {
			type: "custom",
			parse: (value) => ({ lastActiveAt: { $lt: parseDateBound(value, "activeTo", true) } }),
		},
	},
	dateField: "createdAt",
	maxPageSize: 100,
};

const USER_LIST_PROJECTION =
	"firstName lastName email phone roles providerStatus isEmailVerified suspended suspendedAt isProviderAvailable " +
	"createdAt lastActiveAt city state country selectedJobTypes";

export const userListItem = (user: any) => ({
	_id: String(user._id),
	firstName: user.firstName,
	lastName: user.lastName,
	email: user.email,
	phone: user.phone ?? null,
	role: user.roles?.Provider ? "provider" : "customer",
	providerStatus: user.roles?.Provider ? (user.providerStatus ?? "inactive") : null,
	emailVerified: !!user.isEmailVerified,
	suspended: !!user.suspended,
	suspendedAt: user.suspendedAt ?? null,
	available: user.roles?.Provider ? !!user.isProviderAvailable : null,
	services: user.roles?.Provider ? (user.selectedJobTypes ?? []).map((job: any) => job.name || job.id) : [],
	city: user.city ?? null,
	state: user.state ?? null,
	country: user.country ?? null,
	createdAt: user.createdAt ?? null,
	lastActiveAt: user.lastActiveAt ?? null,
});

/** Ids of people a search matches (at most SEARCH_MATCH_LIMIT); null when there is no search. */
export const searchUserIds = async (q: string | undefined) => {
	if (q === undefined) return null;
	const plan = buildSearchPlan(q);
	if (!isSearchable(plan)) return [];
	const users = await runSearch<{ _id: unknown }>(UserModel, userSearchQueries(plan), {
		limit: SEARCH_MATCH_LIMIT,
		projection: "_id",
	});
	return users.map((user) => user._id);
};

/** GET /admin/users */
export const handleListUsers = async (req: Request, res: Response) => {
	try {
		const { rest, values } = takeParams(req.query as Record<string, unknown>, ["q", "hasBookings"]);
		const parsed = parseListQuery(rest, USER_LIST_SPEC);
		const hasBookings = booleanParam(values.hasBookings, "hasBookings");
		const clauses: Record<string, unknown>[] = [];
		const matched = await searchUserIds(values.q);
		if (matched) clauses.push({ _id: { $in: matched } });
		if (hasBookings !== undefined) {
			// Distinct over the booking indexes on userId and providerId.
			const [customers, providers] = await Promise.all([
				BookingModel.distinct("userId").maxTimeMS(DETAIL_TIME_LIMIT_MS).exec(),
				BookingModel.distinct("providerId", { providerId: { $ne: null } })
					.maxTimeMS(DETAIL_TIME_LIMIT_MS)
					.exec(),
			]);
			const ids = [...customers, ...providers];
			clauses.push({ _id: hasBookings ? { $in: ids } : { $nin: ids } });
		}
		res.json(
			await runListQuery(UserModel, parsed, {
				baseFilter: clauses.length ? { $and: clauses } : undefined,
				projection: USER_LIST_PROJECTION,
				map: userListItem,
			}),
		);
	} catch (error) {
		answerError(res, error, "listing users");
	}
};

const sessionView = (session: any) => ({
	sessionId: session.sessionId,
	createdAt: session.createdAt ?? null,
	lastUsedAt: session.lastUsedAt ?? null,
	lastIp: session.lastIp ?? null,
	userAgent: session.userAgent ?? null,
	platform: session.platform ?? null,
	appVersion: session.appVersion ?? null,
	deviceId: session.deviceId ?? null,
});

/** Devices seen in the last 90 days, from the request context recorded on events. */
const recentDevices = async (userId: unknown) =>
	EventModel.aggregate([
		{
			$match: {
				$or: [{ userId: oid(userId) }, { providerId: oid(userId) }],
				at: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
				"context.deviceId": { $exists: true },
			},
		},
		{
			$group: {
				_id: "$context.deviceId",
				platform: { $last: "$context.platform" },
				appVersion: { $last: "$context.appVersion" },
				firstSeenAt: { $min: "$at" },
				lastSeenAt: { $max: "$at" },
				events: { $sum: 1 },
			},
		},
		{ $sort: { lastSeenAt: -1 } },
		{ $limit: 20 },
		{
			$project: {
				_id: 0,
				deviceId: "$_id",
				platform: 1,
				appVersion: 1,
				firstSeenAt: 1,
				lastSeenAt: 1,
				events: 1,
			},
		},
	])
		.option({ maxTimeMS: DETAIL_TIME_LIMIT_MS })
		.exec();

const byStatus = (rows: { _id: string; count: number; amount?: number }[]) =>
	Object.fromEntries(rows.map((row) => [row._id, row.count]));

/** Open bookings a person is part of (customer or provider), soonest first. */
const openBookingsOf = async (userId: unknown) => {
	const bookings = await BookingModel.find({
		$or: [{ userId: oid(userId) }, { providerId: oid(userId) }],
		status: { $in: ["pending", "in progress"] },
	})
		.sort({ startDate: 1 })
		.limit(100)
		.maxTimeMS(DETAIL_TIME_LIMIT_MS)
		.lean()
		.exec();
	return bookings.map((booking) => ({
		_id: String(booking._id),
		reference: bookingReference(booking._id),
		status: booking.status,
		displayStatus: getBookingDisplayStatus(booking),
		role: String(booking.userId) === String(userId) ? "customer" : "provider",
		service: booking.service,
		startDate: booking.startDate,
		amount: roundMoney(booking.rate * booking.hours),
		hasProvider: !!booking.providerId,
	}));
};

/** Stripe connection state of a provider: stored id only, plus Stripe's own flags when it answers within 3 s. */
const stripeState = async (req: Request, accountId: string | null | undefined) => {
	// "status", not "state": the demo masking treats a field named state as a free-text place.
	if (!accountId) return { status: "not_connected", accountId: null };
	// The public demo admin never triggers calls to Stripe.
	if (isDemoAdmin(req.admin)) return { status: "connected", accountId, checked: false };
	const account = await within(
		stripe.accounts.retrieve(accountId).then((a) => a as unknown as Record<string, any>),
		3000,
		null,
	);
	if (!account) return { status: "connected", accountId, checked: false };
	return {
		status: account.details_submitted
			? account.payouts_enabled
				? "ready"
				: "restricted"
			: "onboarding_incomplete",
		accountId,
		checked: true,
		detailsSubmitted: !!account.details_submitted,
		chargesEnabled: !!account.charges_enabled,
		payoutsEnabled: !!account.payouts_enabled,
		requirementsDue: Array.isArray(account.requirements?.currently_due) ? account.requirements.currently_due : [],
	};
};

/** GET /admin/users/:id */
export const handleGetUser = async (req: Request, res: Response) => {
	try {
		const user: any = await UserModel.findById(req.params.id).maxTimeMS(DETAIL_TIME_LIMIT_MS).lean().exec();
		if (!user) return res.status(404).json({ message: "User not found." });
		const id = user._id;
		const isProvider = !!user.roles?.Provider;

		const [
			asCustomer,
			asProvider,
			cancelledByThem,
			cancelledReceived,
			customerBookingIds,
			providerBookingIds,
			devices,
			applications,
			timeline,
			notes,
			audit,
			upcoming,
		] = await Promise.all([
			BookingModel.aggregate([{ $match: { userId: id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
			isProvider
				? BookingModel.aggregate([
						{ $match: { providerId: id } },
						{ $group: { _id: "$status", count: { $sum: 1 } } },
					])
				: Promise.resolve([]),
			BookingModel.countDocuments({
				cancelledBy: id,
				status: "cancelled",
				cancellationReason: { $ne: EXPIRED_REASON },
			}),
			BookingModel.countDocuments({
				$or: [{ userId: id }, { providerId: id }],
				status: "cancelled",
				cancelledBy: { $ne: id },
				cancellationReason: { $ne: EXPIRED_REASON },
			}),
			BookingModel.distinct("_id", { userId: id }),
			isProvider ? BookingModel.distinct("_id", { providerId: id }) : Promise.resolve([]),
			recentDevices(id),
			ProviderApplicationModel.find(
				{ _id: { $in: user.providerApplications ?? [] } },
				"status createdAt reviewedAt jobTypes country state city rejectReason decisions",
			)
				.sort({ createdAt: -1 })
				.lean()
				.exec(),
			eventsFor({ userId: id, providerId: id }, 50),
			notesFor("user", id),
			auditFor(req, "user", id),
			openBookingsOf(id),
		]);

		const [spend] = await PaymentModel.aggregate([
			{ $match: { bookingId: { $in: customerBookingIds }, status: "completed" } },
			{
				$group: {
					_id: null,
					paid: { $sum: "$amount" },
					payments: { $sum: 1 },
					refunded: {
						$sum: {
							$cond: [{ $eq: ["$refundStatus", "succeeded"] }, { $ifNull: ["$refundAmount", 0] }, 0],
						},
					},
					refunds: { $sum: { $cond: [{ $eq: [{ $type: "$refundId" }, "string"] }, 1, 0] } },
				},
			},
		]);

		let provider: Record<string, unknown> | null = null;
		if (isProvider) {
			const [earnings, payouts, recentPayouts, stripeConnection] = await Promise.all([
				EarningModel.aggregate([
					{ $match: { bookingId: { $in: providerBookingIds } } },
					{ $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
				]),
				PayoutModel.aggregate([
					{ $match: { userId: id } },
					{ $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
				]),
				PayoutModel.find({ userId: id }).sort({ createdAt: -1 }).limit(20).lean().exec(),
				stripeState(req, user.stripeConnectedAccountId),
			]);
			const sums = (rows: any[]) =>
				Object.fromEntries(rows.map((row) => [row._id, { count: row.count, amount: roundMoney(row.amount) }]));
			provider = {
				providerStatus: user.providerStatus ?? "inactive",
				services: (user.selectedJobTypes ?? []).map((job: any) => ({ id: job.id, name: job.name })),
				available: !!user.isProviderAvailable,
				approximateLocation: coarseLocation(user.currentLocation?.latitude, user.currentLocation?.longitude),
				locationUpdatedAt: user.locationUpdatedAt ?? null,
				stripe: stripeConnection,
				availableBalance: roundMoney(user.availableBalance ?? 0),
				earnings: sums(earnings),
				payouts: sums(payouts),
				recentPayouts: recentPayouts.map(payoutListItem),
				accountApprovalScreenSeen: !!user.providerAccountApproval,
			};
		}

		res.json({
			user: {
				_id: String(id),
				firstName: user.firstName,
				lastName: user.lastName,
				email: user.email,
				phone: user.phone ?? null,
				role: isProvider ? "provider" : "customer",
				street: user.street ?? null,
				city: user.city ?? null,
				state: user.state ?? null,
				country: user.country ?? null,
				hasPhoto: !!user.profile,
				createdAt: user.createdAt ?? null,
				updatedAt: user.updatedAt ?? null,
				lastActiveAt: user.lastActiveAt ?? null,
			},
			account: {
				emailVerified: !!user.isEmailVerified,
				suspended: !!user.suspended,
				suspendedAt: user.suspendedAt ?? null,
				suspendedReason: user.suspendedReason ?? null,
				suspendedBy: user.suspendedBy ? String(user.suspendedBy) : null,
				activeSessions: (user.sessions ?? []).length + (user.sessionId ? 1 : 0),
			},
			sessions: (user.sessions ?? []).map(sessionView),
			devices,
			totals: {
				bookingsAsCustomer: byStatus(asCustomer),
				bookingsAsProvider: isProvider ? byStatus(asProvider) : null,
				spend: {
					paid: roundMoney(spend?.paid ?? 0),
					payments: spend?.payments ?? 0,
					refunded: roundMoney(spend?.refunded ?? 0),
					refunds: spend?.refunds ?? 0,
				},
				cancellationsMade: cancelledByThem,
				cancellationsReceived: cancelledReceived,
			},
			provider,
			applications: applications.map((application: any) => ({
				_id: String(application._id),
				status: application.status,
				createdAt: application.createdAt,
				reviewedAt: application.reviewedAt ?? null,
				jobTypes: application.jobTypes,
				country: application.country,
				state: application.state,
				city: application.city,
				rejectReason: application.rejectReason || null,
			})),
			openBookings: upcoming,
			timeline,
			notes,
			audit,
		});
	} catch (error) {
		answerError(res, error, "getting user");
	}
};

export const payoutListItem = (payout: any) => ({
	_id: String(payout._id),
	providerId: String(payout.userId),
	amount: roundMoney(payout.amount),
	currency: payout.currency,
	status: payout.status,
	payoutId: payout.payoutId,
	destination: {
		type: payout.destinationDetails?.type ?? null,
		last4: payout.destinationDetails?.last4 ?? null,
		country: payout.destinationDetails?.country ?? null,
	},
	createdAt: payout.createdAt,
	paidAt: payout.paidAt ?? null,
	failedAt: payout.failedAt ?? null,
});

// --- Actions ---------------------------------------------------------------------------------------------------

const userTarget = (id: unknown) => ({ type: "user", id: String(id) });

const subjectsOf = (user: { _id: unknown; roles?: { Provider?: boolean } | null }) => ({
	userId: user._id as any,
	...(user.roles?.Provider ? { providerId: user._id as any } : {}),
});

const loadUser = (id: string) => UserModel.findById(id).exec();

/**
 * POST /admin/users/:id/suspend { reason }. One atomic update: suspended, availability off, every session ended. The
 * provider socket on this instance is closed; others are refused at their next message. Open bookings are listed,
 * not cancelled.
 */
export const handleSuspendUser = async (req: Request, res: Response) => {
	try {
		const reason = String(req.body.reason);
		const now = new Date();
		const before = await UserModel.findOneAndUpdate(
			{ _id: req.params.id, suspended: { $ne: true } },
			suspendUpdate(req.admin!._id, reason, now),
			{ new: false },
		).exec();
		if (!before) {
			const existing = await loadUser(req.params.id);
			if (!existing) return res.status(404).json({ message: "User not found." });
			return res.status(409).json({
				message: "This account is already suspended.",
				suspendedAt: existing.suspendedAt ?? null,
			});
		}
		const sessionsEnded = before.sessions.length + (before.sessionId ? 1 : 0);
		const socketClosed = before.roles?.Provider ? closeProviderSocket(before.email) : false;
		void revokeAllChatTokens(String(before._id));
		forgetAllPush(before);
		const openBookings = await openBookingsOf(before._id);

		await recordAudit(
			{
				action: "users.suspended",
				actor: adminActor(req),
				target: userTarget(before._id),
				before: { suspended: false, available: !!before.isProviderAvailable, sessions: sessionsEnded },
				after: { suspended: true, available: false, sessions: 0 },
				reason,
				metadata: { openBookings: openBookings.length, socketClosed },
			},
			req,
		);
		emitEvent(
			{
				type: "user.suspended",
				actor: { type: "admin", id: req.admin!._id },
				subjects: subjectsOf(before),
				properties: { upcomingBookings: openBookings.length },
			},
			req,
		);
		if (before.isProviderAvailable) {
			emitEvent(
				{
					type: "provider.availability_changed",
					actor: { type: "admin", id: req.admin!._id },
					subjects: { providerId: before._id as any },
					properties: { available: false, via: "admin" },
				},
				req,
			);
		}
		res.json({
			user: userListItem({ ...before.toObject(), suspended: true, suspendedAt: now, isProviderAvailable: false }),
			sessionsEnded,
			availabilityTurnedOff: !!before.isProviderAvailable,
			openBookings,
			note: openBookings.length
				? "These bookings were not cancelled. Cancel or release them from each booking if needed."
				: null,
		});
	} catch (error) {
		answerError(res, error, "suspending user");
	}
};

/** POST /admin/users/:id/reinstate { reason } */
export const handleReinstateUser = async (req: Request, res: Response) => {
	try {
		const before = await UserModel.findOneAndUpdate({ _id: req.params.id, suspended: true }, reinstateUpdate(), {
			new: false,
		}).exec();
		if (!before) {
			const existing = await loadUser(req.params.id);
			if (!existing) return res.status(404).json({ message: "User not found." });
			return res.status(409).json({ message: "This account is not suspended." });
		}
		const suspendedForMs = before.suspendedAt ? Date.now() - before.suspendedAt.getTime() : null;
		await recordAudit(
			{
				action: "users.reinstated",
				actor: adminActor(req),
				target: userTarget(before._id),
				before: { suspended: true, suspendedAt: before.suspendedAt ?? null },
				after: { suspended: false },
				reason: String(req.body.reason),
				metadata: { suspendedReason: before.suspendedReason ?? null },
			},
			req,
		);
		emitEvent(
			{
				type: "user.reinstated",
				actor: { type: "admin", id: req.admin!._id },
				subjects: subjectsOf(before),
				properties: { suspendedForMs },
			},
			req,
		);
		res.json({ user: userListItem({ ...before.toObject(), suspended: false, suspendedAt: null }) });
	} catch (error) {
		answerError(res, error, "reinstating user");
	}
};

/** POST /admin/users/:id/end-sessions { reason }: every app session ends; access tokens stop at their next call. */
export const handleEndUserSessions = async (req: Request, res: Response) => {
	try {
		const before = await UserModel.findOneAndUpdate(
			{ _id: req.params.id },
			{ $set: { sessions: [], refreshToken: [], sessionId: "" } },
			{ new: false },
		).exec();
		if (!before) return res.status(404).json({ message: "User not found." });
		const sessionsEnded = before.sessions.length + (before.sessionId ? 1 : 0);
		const socketClosed = before.roles?.Provider ? closeProviderSocket(before.email) : false;
		void revokeAllChatTokens(String(before._id));
		forgetAllPush(before);
		await recordAudit(
			{
				action: "users.sessions_ended",
				actor: adminActor(req),
				target: userTarget(before._id),
				before: { sessions: sessionsEnded },
				after: { sessions: 0 },
				reason: String(req.body.reason),
				metadata: { socketClosed },
			},
			req,
		);
		emitEvent(
			{
				type: "admin.action_taken",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { userId: before._id as any },
				properties: { action: "users.sessions_ended", targetType: "user" },
			},
			req,
		);
		res.json({ sessionsEnded });
	} catch (error) {
		answerError(res, error, "ending user sessions");
	}
};

/** POST /admin/users/:id/verify-email { reason }: marks the email verified and drops pending verification links. */
export const handleMarkEmailVerified = async (req: Request, res: Response) => {
	try {
		const before = await UserModel.findOneAndUpdate(
			{ _id: req.params.id, isEmailVerified: { $ne: true } },
			{ $set: { isEmailVerified: true, emailVerificationTokens: [] } },
			{ new: false },
		).exec();
		if (!before) {
			const existing = await loadUser(req.params.id);
			if (!existing) return res.status(404).json({ message: "User not found." });
			return res.status(409).json({ message: "This email is already verified." });
		}
		await recordAudit(
			{
				action: "users.email_verified",
				actor: adminActor(req),
				target: userTarget(before._id),
				before: { emailVerified: false },
				after: { emailVerified: true },
				reason: String(req.body.reason),
			},
			req,
		);
		emitEvent(
			{
				type: "user.email_verified",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { userId: before._id as any },
				properties: { by: "admin" },
			},
			req,
		);
		res.json({ emailVerified: true });
	} catch (error) {
		answerError(res, error, "marking email verified");
	}
};

/**
 * POST /admin/users/:id/resend-verification { reason? }: a new verification link through the outbound email module.
 * The email policy applies: a blocked address (disposable, test domain, shared demo account) gets nothing.
 */
export const handleResendVerification = async (req: Request, res: Response) => {
	try {
		const user = await loadUser(req.params.id);
		if (!user) return res.status(404).json({ message: "User not found." });
		if (user.isEmailVerified) return res.status(409).json({ message: "This email is already verified." });
		if (isSuspended(user)) {
			return res.status(409).json({ message: "This account is suspended. Reinstate it before sending email." });
		}
		const result = await sendVerificationEmail(user);
		const outcome = result.status;
		await recordAudit(
			{
				action: "users.verification_email_sent",
				outcome: outcome === "failed" ? "failure" : "success",
				actor: adminActor(req),
				target: userTarget(user._id),
				reason: req.body?.reason ? String(req.body.reason) : null,
				metadata: {
					result: outcome,
					...(result.status === "skipped" ? { skippedBecause: result.reason } : {}),
				},
			},
			req,
		);
		emitEvent(
			{
				type: "admin.action_taken",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { userId: user._id as any },
				properties: { action: "users.verification_email_sent", targetType: "user", result: outcome },
			},
			req,
		);
		if (result.status === "failed") {
			return res.status(502).json({ message: "The email provider refused the message. Try again later." });
		}
		res.json({
			result: outcome,
			...(result.status === "skipped"
				? { skippedBecause: result.reason, message: "Not sent: the email policy blocks this address." }
				: {}),
		});
	} catch (error) {
		answerError(res, error, "resending verification email");
	}
};

/** POST /admin/users/:id/availability-off { reason }: the provider stops getting new-job alerts until they go online. */
export const handleSetAvailabilityOff = async (req: Request, res: Response) => {
	try {
		const user = await loadUser(req.params.id);
		if (!user) return res.status(404).json({ message: "User not found." });
		if (!user.roles?.Provider) return res.status(409).json({ message: "This account is not a provider." });
		const before = await UserModel.findOneAndUpdate(
			{ _id: user._id, isProviderAvailable: true },
			{ $set: { isProviderAvailable: false } },
			{ new: false },
		).exec();
		if (!before) return res.status(409).json({ message: "This provider is already unavailable." });
		// Not enforced beyond this write: a provider app that is open and online sends its own availability with its
		// next update and turns it back on. Suspend the account to keep a provider offline.
		await recordAudit(
			{
				action: "users.availability_off",
				actor: adminActor(req),
				target: userTarget(user._id),
				before: { available: true },
				after: { available: false },
				reason: String(req.body.reason),
			},
			req,
		);
		emitEvent(
			{
				type: "provider.availability_changed",
				actor: { type: "admin", id: req.admin!._id },
				subjects: { providerId: user._id as any },
				properties: { available: false, via: "admin" },
			},
			req,
		);
		res.json({
			available: false,
			note: "If the provider's app is open and online it turns availability back on with its next update.",
		});
	} catch (error) {
		answerError(res, error, "turning availability off");
	}
};
