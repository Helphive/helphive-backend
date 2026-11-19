// Sets emailCanonical (lib/emailAddress.ts canonicalEmail) on every user and lower-cases stored emails that are not
// already lower case, so the sign-up duplicate guard and its unique index cover accounts created before them.
// Accounts that share a canonical address with another account are listed and left exactly as they are (neither is
// changed); decide what to do with each pair by hand. New accounts get the field when they are created.
//
//   npx ts-node scripts/backfill-email-canonical.ts          dry run: what would change, and the shared addresses
//   npx ts-node scripts/backfill-email-canonical.ts --apply  writes it (safe to re-run)
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

import UserModel from "../dal/models/user.model";
import { canonicalEmail } from "../lib/emailAddress";

const BATCH = 500;

const main = async () => {
	const apply = process.argv.includes("--apply");
	if (!process.env.DATABASE_URI) throw new Error("DATABASE_URI is not set.");
	mongoose.set("autoIndex", false);
	await mongoose.connect(process.env.DATABASE_URI);

	const users = await UserModel.find({}, "_id email emailCanonical createdAt").sort({ createdAt: 1 }).lean().exec();
	const groups = new Map<string, typeof users>();
	for (const user of users) {
		const key = canonicalEmail(user.email);
		groups.set(key, [...(groups.get(key) ?? []), user]);
	}

	const shared = [...groups.entries()].filter(([, members]) => members.length > 1);
	const updates: { _id: unknown; set: Record<string, string> }[] = [];
	for (const [canonical, members] of groups) {
		if (members.length > 1) continue;
		const [user] = members;
		const set: Record<string, string> = {};
		if (user.emailCanonical !== canonical) set.emailCanonical = canonical;
		if (user.email !== user.email.toLowerCase()) set.email = user.email.toLowerCase();
		if (Object.keys(set).length) updates.push({ _id: user._id, set });
	}

	const lowered = updates.filter((u) => u.set.email).length;
	console.log(`${users.length} users; ${updates.length} to update (${lowered} emails to lower-case).`);
	if (shared.length) {
		console.log(`\n${shared.length} canonical addresses shared by more than one account (left unchanged):`);
		for (const [canonical, members] of shared) {
			console.log(`  ${canonical}`);
			for (const m of members)
				console.log(`    ${m._id}  ${m.email}  created ${m.createdAt?.toISOString?.() ?? "?"}`);
		}
	}

	if (apply) {
		let written = 0;
		for (let i = 0; i < updates.length; i += BATCH) {
			const result = await UserModel.bulkWrite(
				updates
					.slice(i, i + BATCH)
					.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: u.set } } })),
				{ ordered: false },
			);
			written += result.modifiedCount;
			console.log(`  ${written} written`);
		}
	} else {
		console.log("\nDry run: run again with --apply to write them.");
	}
	await mongoose.disconnect();
};

main().catch(async (error) => {
	console.error(error instanceof Error ? error.message : error);
	await mongoose.disconnect().catch(() => undefined);
	process.exit(1);
});
