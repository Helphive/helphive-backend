// Derives historical business events from existing users, provider applications, bookings, payments, earnings and
// payouts (lib/backfill.ts) and writes them to the events collection.
//
//   npx ts-node scripts/backfill-events.ts                 dry run: counts per event type, writes nothing
//   npx ts-node scripts/backfill-events.ts --apply         writes (upsert by deterministic key; safe to repeat)
//   ... --until=2026-11-20T00:00:00Z                       only events before this time
//
// Without --until, the cut-off is the time of the earliest live event already recorded, so history and live
// recording do not overlap. If there is no live event yet, everything is derived (run it after deploying, so the
// cut-off exists). Reads DATABASE_URI from .env. Run it against production only deliberately.
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

import EventModel from "../dal/models/event.model";
import UserModel from "../dal/models/user.model";
import ProviderApplicationModel from "../dal/models/providerapplication.model";
import BookingModel from "../dal/models/booking.model";
import PaymentModel from "../dal/models/payment.model";
import EarningModel from "../dal/models/earning.model";
import PayoutModel from "../dal/models/payout.model";
import {
	before,
	countByType,
	deriveApplicationEvents,
	deriveBookingEvents,
	deriveEarningEvents,
	derivePaymentEvents,
	derivePayoutEvents,
	deriveUserEvents,
	type BackfillEvent,
} from "../lib/backfill";

const BATCH = 500;

const parseArgs = (argv: string[]) => {
	const apply = argv.includes("--apply");
	const untilArg = argv.find((arg) => arg.startsWith("--until="));
	const until = untilArg ? new Date(untilArg.slice("--until=".length)) : null;
	if (until && Number.isNaN(until.getTime())) throw new Error("--until must be an ISO date or time.");
	const unknown = argv.filter((arg) => arg !== "--apply" && !arg.startsWith("--until="));
	if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(" ")}`);
	return { apply, until };
};

const main = async () => {
	const { apply, until: untilArg } = parseArgs(process.argv.slice(2));
	if (!process.env.DATABASE_URI) throw new Error("DATABASE_URI is not set.");
	mongoose.set("autoIndex", false);
	await mongoose.connect(process.env.DATABASE_URI);

	const firstLive = await EventModel.findOne({ source: "live" }).sort({ at: 1 }).select("at").lean().exec();
	const until = untilArg ?? firstLive?.at ?? null;
	console.log(`Mode: ${apply ? "APPLY (writing)" : "dry run (nothing written)"}`);
	console.log(`Cut-off: ${until ? until.toISOString() : "none (no live events yet)"}`);

	const counts = new Map<string, number>();
	let pending: BackfillEvent[] = [];
	let written = 0;

	const flush = async () => {
		if (!apply || pending.length === 0) {
			pending = [];
			return;
		}
		const result = await EventModel.collection.bulkWrite(
			pending.map((doc) => ({
				updateOne: { filter: { key: doc.key }, update: { $setOnInsert: doc }, upsert: true },
			})),
			{ ordered: false },
		);
		written += result.upsertedCount;
		pending = [];
	};
	const add = async (events: BackfillEvent[]) => {
		const kept = before(events, until);
		countByType(kept, counts);
		pending.push(...kept);
		if (pending.length >= BATCH) await flush();
	};

	// Who submitted each application, and each booking's customer and provider, for subject ids.
	const providerIdByApplication = new Map<string, string>();
	for await (const user of UserModel.find({}, "providerApplications").lean().cursor()) {
		for (const applicationId of user.providerApplications ?? [])
			providerIdByApplication.set(String(applicationId), String(user._id));
	}
	const bookingParties = new Map<string, { userId: string; providerId: string | null }>();
	for await (const booking of BookingModel.find({}, "userId providerId").lean().cursor()) {
		bookingParties.set(String(booking._id), {
			userId: String(booking.userId),
			providerId: booking.providerId ? String(booking.providerId) : null,
		});
	}

	for await (const user of UserModel.find({}, "roles createdAt").lean().cursor()) await add(deriveUserEvents(user));
	for await (const application of ProviderApplicationModel.find(
		{},
		"status createdAt updatedAt reviewedAt reviewedBy rejectReason jobTypes",
	)
		.lean()
		.cursor()) {
		await add(deriveApplicationEvents(application, providerIdByApplication));
	}
	for await (const booking of BookingModel.find({}).lean().cursor()) await add(deriveBookingEvents(booking));
	for await (const payment of PaymentModel.find({}, "-clientSecret").lean().cursor()) {
		await add(derivePaymentEvents(payment, bookingParties.get(String(payment.bookingId))?.userId));
	}
	for await (const earning of EarningModel.find({}).lean().cursor()) {
		await add(deriveEarningEvents(earning, bookingParties.get(String(earning.bookingId))?.providerId));
	}
	for await (const payout of PayoutModel.find({}).lean().cursor()) await add(derivePayoutEvents(payout));
	await flush();

	const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
	console.log("\nEvents derived, by type:");
	for (const [type, count] of [...counts.entries()].sort()) console.log(`  ${type.padEnd(34)} ${count}`);
	console.log(`  ${"total".padEnd(34)} ${total}`);
	if (apply) console.log(`\nNewly written: ${written} (the rest already existed).`);
	else console.log("\nDry run: run again with --apply to write.");
	await mongoose.disconnect();
};

main().catch(async (error) => {
	console.error(error instanceof Error ? error.message : error);
	await mongoose.disconnect().catch(() => undefined);
	process.exit(1);
});
