import mongoose from "mongoose";
import log from "../lib/logger";

/** Wait before the next attempt: 2 s after the first failure, doubling up to 30 s. */
export const reconnectDelayMs = (attempt: number) => Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt - 1));

/**
 * Connects to MongoDB and keeps trying until it succeeds. The driver reconnects by itself when a connection that was
 * once open drops, but it never retries a FIRST connection that failed. Before this loop one failed attempt at start-up
 * (2026-11-20: the only instance of a new revision) left that instance answering every database request with a
 * buffering timeout until it was replaced.
 */
const connectDB = async (
	connect: () => Promise<unknown> = () => mongoose.connect(process.env.DATABASE_URI || ""),
	wait: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) => {
	for (let attempt = 1; ; attempt++) {
		try {
			await connect();
			if (attempt > 1) log.info("db_connected", `Connected to MongoDB on attempt ${attempt}`);
			return attempt;
		} catch (err) {
			log.critical("db_connect_failed", `Could not connect to MongoDB (attempt ${attempt}); trying again`, err);
			await wait(reconnectDelayMs(attempt));
		}
	}
};

export default connectDB;
