import { Request, Response } from "express";
import mongoose from "mongoose";

// GET /healthz: the process is up and serving. GET /readyz: it can also reach MongoDB, within a short timeout.
// Neither is rate limited or logged unless it fails. Neither says anything about configuration or versions.

export const READY_TIMEOUT_MS = 2000;

export const handleHealthz = (_req: Request, res: Response) => {
	res.set("Cache-Control", "no-store").json({ status: "ok" });
};

type Ping = () => Promise<unknown>;

const defaultPing: Ping = async () => {
	const db = mongoose.connection.db;
	if (mongoose.connection.readyState !== 1 || !db) throw new Error("not connected");
	return db.admin().command({ ping: 1 });
};

/** Whether the database answers a ping within the timeout. */
export const checkDatabase = async (ping: Ping = defaultPing, timeoutMs = READY_TIMEOUT_MS) => {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			ping(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			}),
		]);
		return true;
	} catch {
		return false;
	} finally {
		if (timer) clearTimeout(timer);
	}
};

export const handleReadyz = async (_req: Request, res: Response) => {
	const database = await checkDatabase();
	res.set("Cache-Control", "no-store")
		.status(database ? 200 : 503)
		.json({ status: database ? "ready" : "unavailable", checks: { database: database ? "ok" : "unreachable" } });
};
