// The first database connection is retried until it succeeds (a failed first attempt used to leave the instance
// without a database for good). No database here: the connect call and the wait are replaced.
import test from "node:test";
import assert from "node:assert/strict";
import connectDB, { reconnectDelayMs } from "../config/dbConn";
import { setLogSink } from "../lib/logger";

test("a first connection that fails is tried again until it works, waiting longer each time", async () => {
	const logged: string[] = [];
	setLogSink((line: string) => void logged.push(line));
	const waits: number[] = [];
	let calls = 0;
	const attempts = await connectDB(
		async () => {
			calls++;
			if (calls < 4) throw new Error("Could not connect to any servers in your MongoDB Atlas cluster.");
		},
		async (ms) => void waits.push(ms),
	);
	setLogSink(() => undefined);
	assert.equal(attempts, 4);
	assert.equal(calls, 4);
	assert.deepEqual(waits, [2000, 4000, 8000]);
	assert.equal(
		logged.filter((line) => /Could not connect to MongoDB \(attempt \d\); trying again/.test(line)).length,
		3,
	);
	assert.ok(logged.some((line) => /Connected to MongoDB on attempt 4/.test(line)));
});

test("a connection that works first time is one call with no wait", async () => {
	setLogSink(() => undefined);
	const waits: number[] = [];
	let calls = 0;
	const attempts = await connectDB(
		async () => void calls++,
		async (ms) => void waits.push(ms),
	);
	assert.equal(attempts, 1);
	assert.equal(calls, 1);
	assert.deepEqual(waits, []);
});

test("the wait doubles from 2 s and stops growing at 30 s", () => {
	assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(reconnectDelayMs), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});
