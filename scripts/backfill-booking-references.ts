// Stores the receipt reference ("HH-" + last 8 hex digits of the id) on bookings created before it was recorded, so
// the console can find them by the number customers read off their receipt. New bookings get it when created.
//
//   npx ts-node scripts/backfill-booking-references.ts          dry run: how many bookings lack it
//   npx ts-node scripts/backfill-booking-references.ts --apply  writes it (only where missing; safe to re-run)
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

import BookingModel from "../dal/models/booking.model";
import { bookingReference } from "../lib/operations";

const BATCH = 500;

const main = async () => {
	const apply = process.argv.includes("--apply");
	if (!process.env.DATABASE_URI) throw new Error("DATABASE_URI is not set.");
	mongoose.set("autoIndex", false);
	await mongoose.connect(process.env.DATABASE_URI);
	const missing = { reference: { $not: { $type: "string" } } };
	const total = await BookingModel.countDocuments(missing);
	console.log(`${total} bookings without a reference.`);
	if (apply) {
		let written = 0;
		for (;;) {
			const batch = await BookingModel.find(missing, "_id").limit(BATCH).lean().exec();
			if (!batch.length) break;
			const result = await BookingModel.bulkWrite(
				batch.map((booking) => ({
					updateOne: {
						filter: { _id: booking._id, ...missing },
						update: { $set: { reference: bookingReference(booking._id) } },
					},
				})),
			);
			written += result.modifiedCount;
			console.log(`  ${written} written`);
		}
	} else {
		console.log("Dry run: run again with --apply to write them.");
	}
	await mongoose.disconnect();
};

main().catch(async (error) => {
	console.error(error instanceof Error ? error.message : error);
	await mongoose.disconnect().catch(() => undefined);
	process.exit(1);
});
