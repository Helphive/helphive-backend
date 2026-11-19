// The operations overview, the live view and the global search (operations.read), and admin notes (notes.manage).
import { releasePolicy } from "../../lib/platformSettings";
import { Request, Response } from "express";
import BookingModel from "../../dal/models/booking.model";
import PaymentModel from "../../dal/models/payment.model";
import EarningModel from "../../dal/models/earning.model";
import PayoutModel from "../../dal/models/payout.model";
import UserModel from "../../dal/models/user.model";
import ProviderApplicationModel from "../../dal/models/providerapplication.model";
import EventModel from "../../dal/models/event.model";
import AdminNoteModel, { type NoteTargetType } from "../../dal/models/adminNote.model";
import {
	ATTENTION_THRESHOLDS,
	bookingReference,
	buildAttention,
	coarseLocation,
	compareValues,
	parseTimeZone,
	periodBounds,
	platformFeeFromEarning,
	roundMoney,
	type Period,
} from "../../lib/operations";
import {
	applicationSearchQueries,
	bookingSearchQueries,
	buildSearchPlan,
	isSearchable,
	paymentSearchQueries,
	userSearchQueries,
} from "../../lib/adminSearch";
import { getBookingDisplayStatus } from "../user-controllers/utils/booking.utils";
import { adminActor, recordAudit } from "../../lib/audit";
import { emitEvent } from "../../lib/events";
import type { Permission } from "../../config/adminPermissions";
import {
	DETAIL_TIME_LIMIT_MS,
	answerError,
	can,
	loadPeople,
	oid,
	personSummary,
	publicEvent,
	publicNote,
	runSearch,
} from "./operations.shared";

const HOUR = 60 * 60 * 1000;
const T = DETAIL_TIME_LIMIT_MS;

const count = (model: any, filter: Record<string, unknown>) => model.countDocuments(filter).maxTimeMS(T).exec();

const sum = async (model: any, match: Record<string, unknown>, value: unknown) => {
	const [row] = await model
		.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: value }, count: { $sum: 1 } } }])
		.option({ maxTimeMS: T })
		.exec();
	return { total: row?.total ?? 0, count: row?.count ?? 0 };
};

const inRange = (period: Period) => ({ $gte: period.from, $lt: period.to });

/** The numbers compared between two periods. */
const periodMetrics = async (period: Period) => {
	const range = inRange(period);
	const [created, paid, completed, earnings, customers, providers] = await Promise.all([
		count(BookingModel, { createdAt: range }),
		// paidAt is recorded from the admin platform release on; older payments fall back to their creation date.
		sum(
			PaymentModel,
			{
				status: "completed",
				$or: [{ paidAt: range }, { paidAt: { $exists: false }, date: range }],
			},
			"$amount",
		),
		sum(BookingModel, { status: "completed", completedAt: range }, { $multiply: ["$rate", "$hours"] }),
		sum(EarningModel, { createdAt: range }, "$amount"),
		count(UserModel, { "roles.User": true, createdAt: range }),
		count(UserModel, { "roles.Provider": true, createdAt: range }),
	]);
	return {
		bookingsCreated: created as number,
		paidValue: paid.total as number,
		completedValue: completed.total as number,
		platformFees: platformFeeFromEarning(earnings.total),
		newCustomers: customers as number,
		newProviders: providers as number,
	};
};

const compareSets = (current: Awaited<ReturnType<typeof periodMetrics>>, previous: typeof current) => ({
	bookingsCreated: compareValues(current.bookingsCreated, previous.bookingsCreated),
	paidValue: compareValues(current.paidValue, previous.paidValue, true),
	completedValue: compareValues(current.completedValue, previous.completedValue, true),
	platformFees: compareValues(current.platformFees, previous.platformFees, true),
	newCustomers: compareValues(current.newCustomers, previous.newCustomers),
	newProviders: compareValues(current.newProviders, previous.newProviders),
});

/** Paid, unassigned, not-yet-expired bookings starting before `until` (the booking-expired task handles later ones). */
const paidUnassigned = async (until: Date) => {
	const open = await BookingModel.find(
		{ status: "pending", providerId: null, userApprovalRequested: { $ne: true }, startDate: { $lte: until } },
		"_id startDate",
	)
		.sort({ startDate: 1 })
		.limit(500)
		.maxTimeMS(T)
		.lean()
		.exec();
	if (!open.length) return [];
	const paid = new Set(
		(
			await PaymentModel.distinct("bookingId", {
				bookingId: { $in: open.map((b) => b._id) },
				status: "completed",
			})
				.maxTimeMS(T)
				.exec()
		).map(String),
	);
	return open.filter((b) => paid.has(String(b._id)));
};

/** GET /admin/overview?tz=Europe/London */
export const handleOverview = async (req: Request, res: Response) => {
	try {
		const now = new Date();
		const tz = parseTimeZone(req.query.tz);
		const periods = periodBounds(now, tz);
		const lookback = new Date(now.getTime() - ATTENTION_THRESHOLDS.failedLookbackMs);

		// Open, unassigned, not yet started bookings, split by whether they are paid (providers only see paid ones).
		const openUnassigned = await BookingModel.distinct("_id", {
			status: "pending",
			providerId: null,
			userApprovalRequested: { $ne: true },
			startDate: { $gte: now },
		})
			.maxTimeMS(T)
			.exec();
		const waitingForProvider = openUnassigned.length
			? (
					await PaymentModel.distinct("bookingId", {
						bookingId: { $in: openUnassigned },
						status: "completed",
					})
						.maxTimeMS(T)
						.exec()
				).length
			: 0;
		const waitingUnpaid = openUnassigned.length - waitingForProvider;
		const [
			acceptedUpcoming,
			inProgress,
			awaitingStartApproval,
			completedToday,
			cancelledToday,
			providersOnline,
			applicationsWaiting,
			payoutsPending,
			payoutsFailed,
			refundsPending,
			refundsFailed,
		] = await Promise.all([
			count(BookingModel, { status: "pending", providerId: { $ne: null }, userApprovalRequested: { $ne: true } }),
			count(BookingModel, { status: "in progress" }),
			count(BookingModel, { status: "pending", userApprovalRequested: true }),
			count(BookingModel, { status: "completed", completedAt: { $gte: periods.startOfToday } }),
			count(BookingModel, { status: "cancelled", cancelledAt: { $gte: periods.startOfToday } }),
			count(UserModel, {
				isProviderAvailable: true,
				providerStatus: "approved",
				"roles.Provider": true,
				suspended: { $ne: true },
			}),
			count(ProviderApplicationModel, { status: "pending" }),
			count(PayoutModel, { status: "pending" }),
			count(PayoutModel, { status: { $in: ["failed", "cancelled"] }, createdAt: { $gte: lookback } }),
			count(PaymentModel, { refundId: { $type: "string" }, refundStatus: "pending" }),
			count(PaymentModel, {
				refundId: { $type: "string" },
				refundStatus: { $in: ["failed", "cancelled"] },
				refundCreated: { $gte: lookback },
			}),
		]);

		const [today, yesterday, thisWeek, lastWeek] = await Promise.all([
			periodMetrics(periods.today),
			periodMetrics(periods.yesterday),
			periodMetrics(periods.thisWeek),
			periodMetrics(periods.lastWeek),
		]);

		const [unassignedPaid, inProgressRows, startRequests, pendingEarnings, failedPayouts, failedRefunds, apps] =
			await Promise.all([
				paidUnassigned(new Date(now.getTime() + ATTENTION_THRESHOLDS.unassignedWithinMs)),
				BookingModel.find(
					{
						status: "in progress",
						startDate: { $lt: new Date(now.getTime() - ATTENTION_THRESHOLDS.overdueGraceMs) },
					},
					"_id startDate hours",
				)
					.limit(500)
					.maxTimeMS(T)
					.lean()
					.exec(),
				BookingModel.find({ status: "pending", userApprovalRequested: true }, "_id startDate startRequestedAt")
					.limit(500)
					.maxTimeMS(T)
					.lean()
					.exec(),
				EarningModel.find(
					{
						status: "pending",
						createdAt: { $lt: new Date(now.getTime() - ATTENTION_THRESHOLDS.earningReleaseGraceMs) },
					},
					"_id createdAt amount",
				)
					.limit(500)
					.maxTimeMS(T)
					.lean()
					.exec(),
				PayoutModel.find(
					{ status: { $in: ["failed", "cancelled"] }, createdAt: { $gte: lookback } },
					"_id amount failedAt updatedAt status",
				)
					.limit(200)
					.maxTimeMS(T)
					.lean()
					.exec(),
				PaymentModel.find(
					{
						refundId: { $type: "string" },
						refundStatus: { $in: ["failed", "cancelled"] },
						refundCreated: { $gte: lookback },
					},
					"_id refundAmount refundStatus refundCreated updatedAt",
				)
					.limit(200)
					.maxTimeMS(T)
					.lean()
					.exec(),
				ProviderApplicationModel.find(
					{
						status: "pending",
						createdAt: { $lt: new Date(now.getTime() - ATTENTION_THRESHOLDS.applicationWaitMs) },
					},
					"_id createdAt",
				)
					.sort({ createdAt: 1 })
					.limit(200)
					.maxTimeMS(T)
					.lean()
					.exec(),
			]);
		const attention = buildAttention(
			{
				unassignedPaid: unassignedPaid as any,
				inProgress: inProgressRows as any,
				startRequests: startRequests as any,
				pendingEarnings: pendingEarnings as any,
				failedPayouts: failedPayouts as any,
				failedRefunds: failedRefunds as any,
				pendingApplications: apps as any,
			},
			now,
		);

		const activity = await EventModel.find({ source: "live" })
			.sort({ at: -1 })
			.limit(30)
			.maxTimeMS(T)
			.lean()
			.exec();

		res.json({
			generatedAt: now,
			timeZone: tz,
			now: {
				bookingsWaitingForProvider: waitingForProvider,
				bookingsWaitingUnpaid: waitingUnpaid,
				bookingsAcceptedUpcoming: acceptedUpcoming,
				bookingsInProgress: inProgress,
				bookingsAwaitingStartApproval: awaitingStartApproval,
				bookingsCompletedToday: completedToday,
				bookingsCancelledToday: cancelledToday,
				providersOnline,
				applicationsWaiting,
				payoutsPending,
				payoutsFailedLast30Days: payoutsFailed,
				refundsPending,
				refundsFailedLast30Days: refundsFailed,
			},
			periods: {
				today: periods.today,
				yesterday: periods.yesterday,
				thisWeek: periods.thisWeek,
				lastWeek: periods.lastWeek,
			},
			todayVsYesterday: compareSets(today, yesterday),
			thisWeekVsLastWeek: compareSets(thisWeek, lastWeek),
			attention: { items: attention.items, counts: attention.counts },
			recentActivity: activity.map(publicEvent),
		});
	} catch (error) {
		answerError(res, error, "building the overview");
	}
};

/** GET /admin/live?hours=4: providers online and bookings in progress or starting soon, on a coarse grid. */
export const handleLive = async (req: Request, res: Response) => {
	try {
		const raw = req.query.hours;
		if (
			raw !== undefined &&
			(typeof raw !== "string" || !/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 24)
		) {
			return res.status(400).json({ message: "hours must be a whole number from 1 to 24.", field: "hours" });
		}
		const hours = raw === undefined ? 4 : Number(raw);
		const now = new Date();
		const [providers, bookings] = await Promise.all([
			UserModel.find(
				{
					isProviderAvailable: true,
					providerStatus: "approved",
					"roles.Provider": true,
					suspended: { $ne: true },
				},
				"firstName lastName selectedJobTypes currentLocation locationUpdatedAt updatedAt",
			)
				.limit(1000)
				.maxTimeMS(T)
				.lean()
				.exec(),
			BookingModel.find({
				$or: [
					{ status: "in progress" },
					{ status: "pending", startDate: { $gte: now, $lte: new Date(now.getTime() + hours * HOUR) } },
				],
			})
				.sort({ startDate: 1 })
				.limit(500)
				.maxTimeMS(T)
				.lean()
				.exec(),
		]);
		const people = await loadPeople(bookings.flatMap((b) => [b.userId, b.providerId]));
		res.json({
			generatedAt: now,
			hours,
			precision: "Locations are rounded to 0.01 degrees (about 1 km); exact positions are never returned.",
			providers: providers.map((p: any) => ({
				_id: String(p._id),
				firstName: p.firstName,
				lastName: p.lastName,
				services: (p.selectedJobTypes ?? []).map((job: any) => ({ id: job.id, name: job.name })),
				approximateLocation: coarseLocation(p.currentLocation?.latitude, p.currentLocation?.longitude),
				// Older records have no location time; updatedAt is the last change of any kind.
				locationUpdatedAt: p.locationUpdatedAt ?? null,
				updatedAt: p.updatedAt ?? null,
			})),
			bookings: bookings.map((b: any) => ({
				_id: String(b._id),
				reference: bookingReference(b._id),
				status: b.status,
				displayStatus: getBookingDisplayStatus(b),
				service: b.service,
				startDate: b.startDate,
				hours: b.hours,
				startedAt: b.startedAt ?? null,
				approximateLocation: coarseLocation(b.latitude, b.longitude),
				customer: people.get(String(b.userId)) ?? null,
				provider: b.providerId ? (people.get(String(b.providerId)) ?? null) : null,
			})),
		});
	} catch (error) {
		answerError(res, error, "building the live view");
	}
};

const PER_KIND = 5;

/** GET /admin/search?q=: a few typed results per kind, only the kinds this admin may read. */
export const handleGlobalSearch = async (req: Request, res: Response) => {
	try {
		const plan = buildSearchPlan(req.query.q);
		const allowed = (permission: Permission) => can(req, permission);
		const empty = { users: [], bookings: [], payments: [], applications: [] };
		if (!isSearchable(plan)) return res.json({ query: plan.text, results: empty });

		const [users, ownBookings, ownPayments, applications] = await Promise.all([
			allowed("users.read")
				? runSearch<any>(UserModel, userSearchQueries(plan), {
						limit: PER_KIND,
						projection: "firstName lastName email phone roles providerStatus suspended",
					})
				: [],
			allowed("bookings.read")
				? runSearch<any>(BookingModel, bookingSearchQueries(plan), { limit: PER_KIND })
				: [],
			allowed("payments.read")
				? runSearch<any>(PaymentModel, paymentSearchQueries(plan), { limit: PER_KIND })
				: [],
			allowed("applications.read")
				? runSearch<any>(ProviderApplicationModel, applicationSearchQueries(plan), {
						limit: PER_KIND,
						projection: "firstName lastName email status createdAt",
						sort: { createdAt: -1 },
					})
				: [],
		]);

		// Bookings of the people found (most recent first), when the text named a person.
		let bookings = ownBookings;
		if (allowed("bookings.read") && bookings.length < PER_KIND && users.length && !plan.objectId) {
			const ids = users.map((u: any) => u._id);
			const more = await BookingModel.find({ $or: [{ userId: { $in: ids } }, { providerId: { $in: ids } }] })
				.sort({ createdAt: -1 })
				.limit(PER_KIND - bookings.length)
				.maxTimeMS(T)
				.lean()
				.exec();
			const seen = new Set(bookings.map((b: any) => String(b._id)));
			bookings = [...bookings, ...more.filter((b) => !seen.has(String(b._id)))];
		}
		let payments = ownPayments;
		if (allowed("payments.read") && plan.reference && payments.length < PER_KIND) {
			const refBookings = await BookingModel.find({ reference: plan.reference }, "_id")
				.limit(PER_KIND)
				.lean()
				.exec();
			if (refBookings.length) {
				payments = [
					...payments,
					...(await PaymentModel.find({ bookingId: { $in: refBookings.map((b) => b._id) } })
						.limit(PER_KIND - payments.length)
						.lean()
						.exec()),
				];
			}
		}
		const people = await loadPeople(bookings.map((b: any) => b.userId));

		res.json({
			query: plan.text,
			results: {
				users: users.map((u: any) => ({
					type: "user",
					...personSummary(u),
					link: { type: "user", id: String(u._id) },
				})),
				bookings: bookings.map((b: any) => ({
					type: "booking",
					_id: String(b._id),
					reference: bookingReference(b._id),
					service: b.service,
					startDate: b.startDate,
					displayStatus: getBookingDisplayStatus(b),
					customerName: people.get(String(b.userId))?.name ?? null,
					link: { type: "booking", id: String(b._id) },
				})),
				payments: payments.map((p: any) => ({
					type: "payment",
					_id: String(p._id),
					bookingReference: bookingReference(p.bookingId),
					amount: roundMoney(p.amount),
					status: p.status,
					refundStatus: p.refundId ? p.refundStatus : null,
					createdAt: p.createdAt ?? p.date,
					link: { type: "payment", id: String(p._id) },
				})),
				applications: applications.map((a: any) => ({
					type: "application",
					_id: String(a._id),
					name: `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim(),
					email: a.email,
					status: a.status,
					createdAt: a.createdAt,
					link: { type: "application", id: String(a._id) },
				})),
			},
		});
	} catch (error) {
		answerError(res, error, "searching");
	}
};

// --- Notes -------------------------------------------------------------------------------------------------------

const NOTE_TARGETS: Record<
	NoteTargetType,
	{ model: any; read: Permission; event: "userId" | "bookingId" | "paymentId" | "applicationId" }
> = {
	user: { model: UserModel, read: "users.read", event: "userId" },
	booking: { model: BookingModel, read: "bookings.read", event: "bookingId" },
	payment: { model: PaymentModel, read: "payments.read", event: "paymentId" },
	application: { model: ProviderApplicationModel, read: "applications.read", event: "applicationId" },
};

const noteEvent = (req: Request, action: string, targetType: NoteTargetType, targetId: unknown) =>
	emitEvent(
		{
			type: "admin.action_taken",
			actor: { type: "admin", id: req.admin!._id },
			subjects: { [NOTE_TARGETS[targetType].event]: targetId as any },
			properties: { action, targetType },
		},
		req,
	);

/** POST /admin/notes { targetType, targetId, body } */
export const handleCreateNote = async (req: Request, res: Response) => {
	try {
		const targetType = req.body.targetType as NoteTargetType;
		const target = NOTE_TARGETS[targetType];
		if (!can(req, target.read)) {
			return res
				.status(403)
				.json({ message: "Your role does not allow reading this record.", permission: target.read });
		}
		if (!(await target.model.exists({ _id: oid(req.body.targetId) }))) {
			return res.status(404).json({ message: "The record for this note was not found." });
		}
		const note = await AdminNoteModel.create({
			targetType,
			targetId: oid(req.body.targetId),
			body: String(req.body.body).trim(),
			author: { id: req.admin!._id, email: req.admin!.email },
		});
		await recordAudit(
			{
				action: "notes.created",
				actor: adminActor(req),
				target: { type: targetType, id: String(note.targetId) },
				after: { noteId: String(note._id), body: note.body },
			},
			req,
		);
		noteEvent(req, "notes.created", targetType, note.targetId);
		res.status(201).json({ note: publicNote(note.toObject()) });
	} catch (error) {
		answerError(res, error, "creating note");
	}
};

const ownOrSuper = (req: Request, note: any) =>
	String(note.author?.id) === String(req.admin!._id) || can(req, "admins.manage");

/** PATCH /admin/notes/:id { body, reason? }: the author (or a super admin) edits the text. */
export const handleUpdateNote = async (req: Request, res: Response) => {
	try {
		const note = await AdminNoteModel.findOne({ _id: req.params.id, deletedAt: null }).exec();
		if (!note) return res.status(404).json({ message: "Note not found." });
		if (!ownOrSuper(req, note))
			return res.status(403).json({ message: "Only the author or a super admin can edit a note." });
		const before = note.body;
		const body = String(req.body.body).trim();
		const updated = await AdminNoteModel.findOneAndUpdate(
			{ _id: note._id, deletedAt: null, body: before },
			{ $set: { body, editedAt: new Date() } },
			{ new: true },
		).exec();
		if (!updated) return res.status(409).json({ message: "This note changed meanwhile. Reload it." });
		await recordAudit(
			{
				action: "notes.updated",
				actor: adminActor(req),
				target: { type: note.targetType, id: String(note.targetId) },
				before: { noteId: String(note._id), body: before },
				after: { noteId: String(note._id), body },
				reason: req.body.reason ? String(req.body.reason) : null,
			},
			req,
		);
		noteEvent(req, "notes.updated", note.targetType, note.targetId);
		res.json({ note: publicNote(updated.toObject()) });
	} catch (error) {
		answerError(res, error, "updating note");
	}
};

/** DELETE /admin/notes/:id { reason }: hidden from the record; the text stays in the audit entry. */
export const handleDeleteNote = async (req: Request, res: Response) => {
	try {
		const note = await AdminNoteModel.findOne({ _id: req.params.id, deletedAt: null }).exec();
		if (!note) return res.status(404).json({ message: "Note not found." });
		if (!ownOrSuper(req, note)) {
			return res.status(403).json({ message: "Only the author or a super admin can delete a note." });
		}
		const deleted = await AdminNoteModel.findOneAndUpdate(
			{ _id: note._id, deletedAt: null },
			{ $set: { deletedAt: new Date(), deletedBy: req.admin!._id } },
		).exec();
		if (!deleted) return res.status(404).json({ message: "Note not found." });
		await recordAudit(
			{
				action: "notes.deleted",
				actor: adminActor(req),
				target: { type: note.targetType, id: String(note.targetId) },
				before: { noteId: String(note._id), body: note.body },
				after: { noteId: String(note._id), deleted: true },
				reason: String(req.body.reason),
			},
			req,
		);
		noteEvent(req, "notes.deleted", note.targetType, note.targetId);
		res.status(204).end();
	} catch (error) {
		answerError(res, error, "deleting note");
	}
};

/**
 * GET /admin/platform/settings: what the console shows as platform notices. Stripe mode comes from the secret key's
 * prefix (the key itself is never returned).
 */
export const handlePlatformSettings = (_req: Request, res: Response) => {
	res.json({ earningsRelease: releasePolicy() });
};
