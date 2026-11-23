// Index creation at start-up.
//
// Mongoose's autoIndex (on by default, and what this app has always used) calls createIndexes for every model when
// the connection opens. createIndexes only adds indexes that are missing; it never drops or rebuilds one. On Atlas
// (MongoDB 4.4+) an index build holds an exclusive lock only briefly at its start and end, so reads and writes carry on
// while it runs, and several Cloud Run instances starting together issue identical requests that MongoDB builds once.
// None of the indexes added for the admin console is unique on an existing collection, so none can fail on existing
// data. The only unique ones are on new, empty collections (events.key, webhookevents provider+eventId).
//
// MONGOOSE_AUTO_INDEX=false turns this off (e.g. for a very large collection, to build in a maintenance window); then
// run `npx ts-node scripts/create-indexes.ts --apply` to create them explicitly.
import mongoose from "mongoose";
import log from "../lib/logger";

export const autoIndexEnabled = (value = process.env.MONGOOSE_AUTO_INDEX) =>
	!["false", "0", "no", "off"].includes((value ?? "").trim().toLowerCase());

/** Sets autoIndex before any connection opens. Call before connectDB(). */
export const configureIndexing = () => {
	mongoose.set("autoIndex", autoIndexEnabled());
};

/**
 * Once connected, waits for each model's index build and logs any that failed (Mongoose otherwise only emits an
 * "error" event on the model, which nothing listens to). Never throws.
 */
export const reportIndexBuilds = () => {
	if (!autoIndexEnabled()) {
		log.info(
			"index_creation_off",
			"Automatic index creation is off (MONGOOSE_AUTO_INDEX=false); run scripts/create-indexes.ts.",
		);
		return;
	}
	const models = Object.values(mongoose.models);
	Promise.allSettled(models.map((model) => model.init())).then((results) => {
		const failed = results
			.map((result, i) => ({ result, name: models[i].modelName }))
			.filter(({ result }) => result.status === "rejected");
		for (const { name, result } of failed) {
			log.error(
				"index_creation_failed",
				`Index creation failed for ${name}`,
				(result as PromiseRejectedResult).reason,
			);
		}
		log.info("indexes_checked", `Indexes checked for ${models.length} models; ${failed.length} failed.`);
	});
};
