// Schedules the no-show check (lib/noShow.ts) for bookings a provider accepted BEFORE the check existed: the accept
// endpoint schedules it for every booking accepted since. One Cloud Task per booking that is still accepted with no
// start request; a booking already past its due time gets a task that runs at once, so the server cancels it, tells
// both people and refunds the customer exactly as it does for any other booking.
//
//   npx ts-node scripts/schedule-no-show-checks.ts           dry run: what would be scheduled (counts only)
//   npx ts-node scripts/schedule-no-show-checks.ts --apply   create the tasks
//
// Safe to re-run: a second task for the same booking finds nothing left to do. Needs DATABASE_URI, SERVER_BASE_URL and
// the Cloud Tasks variables and credentials. Prints counts and booking references, never names or emails.
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

import BookingModel from "../dal/models/booking.model";
import { getSettings } from "../lib/settings";
import { decideNoShow, noShowCheckAt, noShowDueAt } from "../lib/noShow";
import { createGoogleCloudTaskBookingNoShowTrigger } from "../controllers/user-controllers/utils/user.utils";

const main = async () => {
	const apply = process.argv.includes("--apply");
	if (!process.env.DATABASE_URI) throw new Error("DATABASE_URI is not set.");
	mongoose.set("autoIndex", false);
	await mongoose.connect(process.env.DATABASE_URI);
	const now = new Date();
	const graceMinutes = (await getSettings())["bookings.noShowGraceMinutes"];

	const waiting = await BookingModel.find(
		{ status: "pending", providerId: { $ne: null }, userApprovalRequested: { $ne: true } },
		"_id status providerId userApprovalRequested startDate hours reference",
	)
		.sort({ startDate: 1 })
		.lean()
		.exec();

	const due = waiting.filter((b) => decideNoShow(b as any, now, graceMinutes) === "cancel");
	const later = waiting.filter((b) => decideNoShow(b as any, now, graceMinutes) === "not_due");
	console.log(`Grace period: ${graceMinutes} minutes after the scheduled end.`);
	console.log(`Accepted bookings with no start request: ${waiting.length}`);
	console.log(`  past their due time (cancelled and refunded as soon as the task runs): ${due.length}`);
	for (const b of due) {
		const dueAt = noShowDueAt(b as any, graceMinutes) as Date;
		console.log(
			`    ${b.reference ?? String(b._id)}  shift started ${new Date(b.startDate).toISOString()}, due since ${dueAt.toISOString()}`,
		);
	}
	console.log(`  not due yet (checked when their shift and grace are over): ${later.length}`);
	console.log(`  without a valid shift (left alone): ${waiting.length - due.length - later.length}`);

	if (!apply) {
		console.log("Dry run: run again with --apply to create the tasks.");
	} else {
		let created = 0;
		let failed = 0;
		for (const b of [...due, ...later]) {
			const dueAt = noShowDueAt(b as any, graceMinutes) as Date;
			try {
				await createGoogleCloudTaskBookingNoShowTrigger(String(b._id), noShowCheckAt(dueAt, now));
				created++;
			} catch (error) {
				failed++;
				console.error(
					`Could not schedule ${b.reference ?? String(b._id)}: ${error instanceof Error ? error.message : "error"}`,
				);
			}
		}
		console.log(`Created ${created} task(s); ${failed} failed (re-run to retry them).`);
	}
	await mongoose.disconnect();
};

main().catch(async (error) => {
	console.error(error instanceof Error ? error.message : error);
	await mongoose.disconnect().catch(() => undefined);
	process.exit(1);
});
