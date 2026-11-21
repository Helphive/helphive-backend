// Run with: node -r ts-node/register/transpile-only --test tests/loadSecrets.test.ts
// The secrets bundle: APP_SECRETS (JSON) is unpacked into process.env and removed; nothing happens without it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import path from "path";

const probe = (env: NodeJS.ProcessEnv) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				"-r",
				"ts-node/register/transpile-only",
				"-e",
				`require("./config/loadSecrets"); const e = process.env; console.log(JSON.stringify({ a: e.HH_TEST_A ?? null, key: e.HH_TEST_KEY ?? null, bundle: e.APP_SECRETS ?? null }))`,
			],
			{ cwd: path.join(__dirname, ".."), env: { PATH: process.env.PATH, ...env }, encoding: "utf8" },
		),
	);

test("unpacks APP_SECRETS, keeps multi-line values, and removes the bundle", () => {
	const bundle = JSON.stringify({ HH_TEST_A: "from-secret", HH_TEST_KEY: "line1\nline2" });
	assert.deepEqual(probe({ APP_SECRETS: bundle }), { a: "from-secret", key: "line1\nline2", bundle: null });
});

test("does nothing without APP_SECRETS", () => {
	assert.deepEqual(probe({}), { a: null, key: null, bundle: null });
});
