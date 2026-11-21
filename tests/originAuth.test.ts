// Run with: npx ts-node tests/originAuth.test.ts
// Origin auth: requests through the Cloudflare Worker carry the shared secret and the visitor's IP; direct calls are
// logged (log mode) or refused (enforce); probes and local development (no secret) are never checked.
import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import { checkOrigin, originAuth } from "../lib/originAuth";

const SECRET = "s".repeat(48);

test("checkOrigin: off without a secret, worker with the right one, direct otherwise", () => {
	assert.deepEqual(checkOrigin({ "x-origin-auth": SECRET }, {}), { status: "off" });
	assert.deepEqual(
		checkOrigin({ "x-origin-auth": SECRET, "x-client-ip": " 203.0.113.9 " }, { ORIGIN_AUTH: SECRET }),
		{
			status: "worker",
			clientIp: "203.0.113.9",
		},
	);
	assert.deepEqual(checkOrigin({ "x-origin-auth": SECRET }, { ORIGIN_AUTH: SECRET }), { status: "worker" });
	assert.deepEqual(checkOrigin({ "x-origin-auth": `${SECRET}x` }, { ORIGIN_AUTH: SECRET }), {
		status: "direct",
		enforce: false,
	});
	assert.deepEqual(
		checkOrigin({ "x-client-ip": "203.0.113.9" }, { ORIGIN_AUTH: SECRET, ORIGIN_AUTH_MODE: "enforce" }),
		{
			status: "direct",
			enforce: true,
		},
	);
});

const serve = async () => {
	const app = express();
	app.set("trust proxy", 1);
	app.use(originAuth);
	app.get(["/readyz", "/whoami"], (req, res) => res.json({ ip: req.ip }));
	const server = http.createServer(app);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { base, close: () => new Promise((resolve) => server.close(resolve)) };
};

const setEnv = (env: Record<string, string | undefined>) => {
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
};

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	setEnv(env);
	try {
		await fn();
	} finally {
		setEnv(saved);
	}
};

test("middleware: visitor IP only with the secret; log mode passes, enforce refuses; probes exempt", async () => {
	const app = await serve();
	try {
		const get = (path: string, headers: Record<string, string> = {}) =>
			fetch(`${app.base}${path}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
		await withEnv({ ORIGIN_AUTH: SECRET, ORIGIN_AUTH_MODE: undefined }, async () => {
			const worker = await get("/whoami", { "x-origin-auth": SECRET, "x-client-ip": "203.0.113.9" });
			assert.deepEqual(worker, { status: 200, body: { ip: "203.0.113.9" } });
			const spoofed = await get("/whoami", { "x-client-ip": "203.0.113.9" });
			assert.equal(spoofed.status, 200, "log mode lets it through");
			assert.notEqual(spoofed.body.ip, "203.0.113.9", "X-Client-IP is ignored without the secret");
		});
		await withEnv({ ORIGIN_AUTH: SECRET, ORIGIN_AUTH_MODE: "enforce" }, async () => {
			assert.equal((await get("/whoami")).status, 403);
			assert.equal((await get("/whoami", { "x-origin-auth": "wrong" })).status, 403);
			assert.equal((await get("/whoami", { "x-origin-auth": SECRET })).status, 200);
			assert.equal((await get("/readyz")).status, 200, "Cloud Run probe");
		});
		await withEnv({ ORIGIN_AUTH: undefined, ORIGIN_AUTH_MODE: "enforce" }, async () => {
			assert.equal((await get("/whoami")).status, 200, "no secret configured: local development");
		});
	} finally {
		await app.close();
	}
});
