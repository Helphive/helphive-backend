// Run with: node -r ts-node/register/transpile-only --test tests/loadSecrets.test.ts
// The secrets bundle: loaded from SECRETS_FILE when present, plain env vars win, nothing happens when it is absent.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const probe = (env: NodeJS.ProcessEnv) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				"-r",
				"ts-node/register/transpile-only",
				"-e",
				`require("./config/loadSecrets"); console.log(JSON.stringify({ a: process.env.HH_TEST_A ?? null, b: process.env.HH_TEST_B ?? null, key: process.env.HH_TEST_KEY ?? null }))`,
			],
			{ cwd: path.join(__dirname, ".."), env: { PATH: process.env.PATH, ...env }, encoding: "utf8" },
		),
	);

test("loads the bundle, keeps plain env vars, and keeps multi-line values", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-secrets-"));
	const file = path.join(dir, "app.env");
	fs.writeFileSync(file, `HH_TEST_A='from-file'\nHH_TEST_B='from-file'\nHH_TEST_KEY="line1\\nline2"\n`);
	try {
		assert.deepEqual(probe({ SECRETS_FILE: file, HH_TEST_B: "plain" }), {
			a: "from-file",
			b: "plain",
			key: "line1\nline2",
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("does nothing when the file is absent", () => {
	assert.deepEqual(probe({ SECRETS_FILE: path.join(os.tmpdir(), "hh-no-such-file.env") }), {
		a: null,
		b: null,
		key: null,
	});
});
