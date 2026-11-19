// Creates the indexes the models declare, for when automatic index creation is off (MONGOOSE_AUTO_INDEX=false).
// Never drops or changes an existing index.
//
//   npx ts-node scripts/create-indexes.ts          dry run: lists declared indexes missing from the database
//   npx ts-node scripts/create-indexes.ts --apply  creates them
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

import "../dal/models/admin.model";
import "../dal/models/adminNote.model";
import "../dal/models/adminSession.model";
import "../dal/models/auditLog.model";
import "../dal/models/booking.model";
import "../dal/models/earning.model";
import "../dal/models/event.model";
import "../dal/models/notification.model";
import "../dal/models/payment.model";
import "../dal/models/payout.model";
import "../dal/models/providerapplication.model";
import "../dal/models/ratelimit.model";
import "../dal/models/taskRun.model";
import "../dal/models/user.model";
import "../dal/models/webhookEvent.model";

// Two indexes on the same keys differ by collation (the case-insensitive *_ci search indexes sit beside the plain ones).
const keyOf = (spec: Record<string, unknown>, collation?: { locale?: string; strength?: number } | null) =>
	JSON.stringify(spec) + (collation?.locale ? `|${collation.locale}/${collation.strength ?? 3}` : "");

const main = async () => {
	const apply = process.argv.includes("--apply");
	if (!process.env.DATABASE_URI) throw new Error("DATABASE_URI is not set.");
	mongoose.set("autoIndex", false);
	await mongoose.connect(process.env.DATABASE_URI);
	for (const model of Object.values(mongoose.models)) {
		const existing = await model.collection.indexes().catch(() => []);
		const existingKeys = new Set(existing.map((index) => keyOf(index.key, index.collation as any)));
		const missing = model.schema
			.indexes()
			.filter(([spec, options]) => !existingKeys.has(keyOf(spec, (options as any)?.collation)));
		console.log(`${model.collection.collectionName}: ${missing.length} missing`);
		for (const [spec, options] of missing) console.log(`  ${keyOf(spec)} ${JSON.stringify(options ?? {})}`);
		if (apply && missing.length) await model.createIndexes();
	}
	if (!apply) console.log("\nDry run: run again with --apply to create them.");
	await mongoose.disconnect();
};

main().catch(async (error) => {
	console.error(error instanceof Error ? error.message : error);
	await mongoose.disconnect().catch(() => undefined);
	process.exit(1);
});
