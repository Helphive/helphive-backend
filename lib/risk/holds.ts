// Payout holds on providers. A hold (kind "hold") stops payout requests and earning releases; "review_before_payout"
// stops payout requests until an admin releases it. Enforcement reads users.payoutHold, kept in step with the active
// holds here, inside the same atomic update that reserves the balance for a payout (provider.controller.ts), so a
// payout racing a new hold cannot slip through. Releasing a hold reschedules the earnings it kept back.
import type mongoose from "mongoose";
import UserModel from "../../dal/models/user.model";
import BookingModel from "../../dal/models/booking.model";
import EarningModel from "../../dal/models/earning.model";
import { RiskHoldModel, type HoldKind } from "../../dal/models/risk.model";
import log from "../logger";

export type PayoutHoldState = "hold" | "review" | null;

/** What the provider sees when a payout is refused. */
export const PAYOUT_HELD = {
	status: 403,
	body: {
		message:
			"Payouts on your account are paused while we review recent activity. Your balance is safe. Contact HelpHive support if you have questions.",
		code: "payouts_on_hold",
	},
} as const;

/** The user's flag from their active holds: any "hold" wins over a review. */
export const holdStateFrom = (holds: readonly { kind: string }[]): PayoutHoldState =>
	holds.some((h) => h.kind === "hold") ? "hold" : holds.length ? "review" : null;

export const blocksPayout = (state: unknown) => state === "hold" || state === "review";
export const blocksEarningRelease = (state: unknown) => state === "hold";

/** The filter that reserves a payout amount only for a provider without a hold (missing or null flag). */
export const payoutReservationFilter = (userId: unknown, amount: number) => ({
	_id: userId,
	availableBalance: { $gte: amount },
	payoutHold: { $in: [null] },
});

/** Sets users.payoutHold from the active holds. */
export const syncUserHoldFlag = async (userId: mongoose.Types.ObjectId | string) => {
	const active = await RiskHoldModel.find({ userId, active: true }, "kind").lean().exec();
	const state = holdStateFrom(active);
	await UserModel.updateOne(
		{ _id: userId },
		state ? { $set: { payoutHold: state } } : { $unset: { payoutHold: 1 } },
	).exec();
	return state;
};

export interface HoldSource {
	type: "rule" | "admin" | "case";
	ruleKey?: string;
	caseId?: mongoose.Types.ObjectId | string;
	adminId?: mongoose.Types.ObjectId | string;
	adminEmail?: string;
}

const DUPLICATE_KEY = 11000;

/**
 * Places a hold unless one of the same kind is already active (then that one is returned, created false). The user
 * flag is set before returning, so enforcement starts with the response.
 */
export const placeHold = async (input: {
	userId: mongoose.Types.ObjectId | string;
	kind: HoldKind;
	reason: string;
	source: HoldSource;
}) => {
	const existing = await RiskHoldModel.findOne({ userId: input.userId, kind: input.kind, active: true }).exec();
	if (existing) return { hold: existing, created: false };
	try {
		const hold = await RiskHoldModel.create({ ...input, active: true });
		await syncUserHoldFlag(input.userId);
		return { hold, created: true };
	} catch (error: any) {
		if (error?.code !== DUPLICATE_KEY) throw error;
		const winner = await RiskHoldModel.findOne({ userId: input.userId, kind: input.kind, active: true }).exec();
		return { hold: winner!, created: false };
	}
};

/** Releases one active hold (null when it was not active). Earnings kept back are rescheduled when no hold remains. */
export const releaseHold = async (
	holdId: mongoose.Types.ObjectId | string,
	release: { by: { id?: unknown; email?: string | null }; reason: string },
) => {
	const before = await RiskHoldModel.findOneAndUpdate(
		{ _id: holdId, active: true },
		{
			$set: {
				active: false,
				releasedAt: new Date(),
				releasedBy: { id: release.by.id ?? null, email: release.by.email ?? null },
				releaseReason: release.reason,
			},
		},
		{ new: false },
	).exec();
	if (!before) return null;
	const state = await syncUserHoldFlag(before.userId);
	const rescheduled = blocksEarningRelease(state) ? 0 : await rescheduleHeldEarnings(before.userId);
	return { hold: before, state, rescheduled };
};

/** Counts what a hold stopped (shown on the holds page). Best effort. */
export const recordBlocked = (userId: unknown, what: "payouts" | "earnings") =>
	RiskHoldModel.updateMany({ userId, active: true }, { $inc: { [`blocked.${what}`]: 1 } })
		.exec()
		.catch((error) => log.error("Could not count a blocked payout or earning", error));

/** At most this many kept-back earnings are rescheduled per release (the rest are released by the overview's attention list). */
export const MAX_RESCHEDULE = 100;

/** Asks Cloud Tasks to run the earning release again for the provider's pending earnings. */
export const rescheduleHeldEarnings = async (providerId: mongoose.Types.ObjectId | string) => {
	try {
		const bookings = await BookingModel.find({ providerId, status: "completed" }, "_id").lean().exec();
		const pending = await EarningModel.find(
			{ bookingId: { $in: bookings.map((b) => b._id) }, status: "pending" },
			"bookingId",
		)
			.limit(MAX_RESCHEDULE)
			.lean()
			.exec();
		if (!pending.length) return 0;
		// Loaded lazily: the Cloud Tasks client is built on import.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { createGoogleCloudTaskPaymentTrigger } = require("../../controllers/user-controllers/utils/auth.utils");
		let scheduled = 0;
		for (const earning of pending) {
			try {
				await createGoogleCloudTaskPaymentTrigger(String(earning.bookingId), new Date(Date.now() + 5000));
				scheduled++;
			} catch (error) {
				log.error(`Could not reschedule the earning release for booking ${earning.bookingId}`, error);
			}
		}
		return scheduled;
	} catch (error) {
		log.error("Could not reschedule held earnings", error);
		return 0;
	}
};
