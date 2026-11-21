// Run with: npx ts-node tests/clientAttest.test.ts
// Client attestation: verdict rules, pass sign/verify, debug tokens, the pass middleware and POST /client-attest with
// Google mocked (no network).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "net";
import { setLogSink } from "../lib/logger";
import { ANDROID_APP_ID, SIGNING_KEY_SHA256 } from "../lib/appIdentity";
import {
	RELEASE_CERT_DIGEST,
	certDigestFromFingerprint,
	evaluateIntegrityPayload,
	evaluateRecaptchaAssessment,
	expectedRequestHash,
	isAllowedWebHostname,
} from "../lib/clientAttest/verdict";
import { isDebugToken, signPass, verifyPass } from "../lib/clientAttest/pass";
import { debugTokens } from "../lib/clientAttest/config";
import { GoogleCallError, type AttestGoogle } from "../lib/clientAttest/google";
import { clientPassGuard } from "../middleware/clientPass";
import { attestBodyError, createClientAttestHandler } from "../routes/clientAttest.route";

const logged: string[] = [];
setLogSink((line) => logged.push(line));

const SECRET = "s".repeat(40);
const DEVICE = "device-12345678";
const NOW = 1_800_000_000_000;

// ---- Play Integrity verdicts ----

const goodPayload = (overrides: Record<string, any> = {}) => ({
	requestDetails: {
		requestPackageName: ANDROID_APP_ID,
		requestHash: expectedRequestHash(DEVICE),
		timestampMillis: String(NOW - 10_000),
	},
	appIntegrity: {
		appRecognitionVerdict: "UNRECOGNIZED_VERSION",
		packageName: ANDROID_APP_ID,
		certificateSha256Digest: [RELEASE_CERT_DIGEST],
	},
	deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
	accountDetails: { appLicensingVerdict: "UNEVALUATED" },
	...overrides,
});
const reasonOf = (payload: unknown) => {
	const verdict = evaluateIntegrityPayload(payload, DEVICE, NOW);
	return verdict.ok ? "ok" : verdict.reason;
};

test("cert digest: colon hex becomes base64url without padding", () => {
	assert.equal(certDigestFromFingerprint("00:FF:10"), "AP8Q");
	assert.equal(RELEASE_CERT_DIGEST, Buffer.from(SIGNING_KEY_SHA256.replace(/:/g, ""), "hex").toString("base64url"));
	assert.equal(RELEASE_CERT_DIGEST.length, 43);
	assert.doesNotMatch(RELEASE_CERT_DIGEST, /[=+/]/);
});

test("request hash: base64url sha256 of the prefixed device id", () => {
	const expected = crypto.createHash("sha256").update(`helphive-client-attest|${DEVICE}`).digest("base64url");
	assert.equal(expectedRequestHash(DEVICE), expected);
	assert.notEqual(expectedRequestHash(DEVICE), expectedRequestHash("other-device-1"));
});

test("integrity: a sideloaded build (UNRECOGNIZED_VERSION) on a genuine device is accepted", () => {
	const verdict = evaluateIntegrityPayload(goodPayload(), DEVICE, NOW);
	assert.equal(verdict.ok, true);
	assert.equal(verdict.summary.certMatch, "yes");
	assert.equal(verdict.summary.ageSeconds, 10);
});

test("integrity: PLAY_RECOGNIZED and extra device labels are accepted too", () => {
	const payload = goodPayload();
	payload.appIntegrity.appRecognitionVerdict = "PLAY_RECOGNIZED";
	payload.deviceIntegrity.deviceRecognitionVerdict = ["MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY"];
	assert.equal(reasonOf(payload), "ok");
});

test("integrity: each failure reason", () => {
	const wrongPackage = goodPayload();
	wrongPackage.requestDetails.requestPackageName = "com.evil.app";
	assert.equal(reasonOf(wrongPackage), "package");

	const wrongHash = goodPayload();
	wrongHash.requestDetails.requestHash = expectedRequestHash("someone-elses-device");
	assert.equal(reasonOf(wrongHash), "request_hash");

	const old = goodPayload();
	old.requestDetails.timestampMillis = String(NOW - 5 * 60_000 - 1);
	assert.equal(reasonOf(old), "stale");
	const future = goodPayload();
	future.requestDetails.timestampMillis = String(NOW + 61_000);
	assert.equal(reasonOf(future), "stale");
	const noTime = goodPayload();
	delete (noTime.requestDetails as any).timestampMillis;
	assert.equal(reasonOf(noTime), "stale");

	const unevaluated = goodPayload();
	unevaluated.appIntegrity.appRecognitionVerdict = "UNEVALUATED";
	assert.equal(reasonOf(unevaluated), "app_cert");

	const foreignCert = goodPayload();
	foreignCert.appIntegrity.certificateSha256Digest = [certDigestFromFingerprint("AA:BB:CC")];
	assert.equal(reasonOf(foreignCert), "app_cert");

	const noCert = goodPayload();
	delete (noCert.appIntegrity as any).certificateSha256Digest;
	assert.equal(reasonOf(noCert), "app_cert");

	const otherPackage = goodPayload();
	otherPackage.appIntegrity.packageName = "com.evil.app";
	assert.equal(reasonOf(otherPackage), "app_cert");

	const basicOnly = goodPayload();
	basicOnly.deviceIntegrity.deviceRecognitionVerdict = ["MEETS_BASIC_INTEGRITY"];
	assert.equal(reasonOf(basicOnly), "device_integrity");
	const noDevice = goodPayload();
	noDevice.deviceIntegrity = {} as any;
	assert.equal(reasonOf(noDevice), "device_integrity");
});

test("integrity: a padded or standard-base64 digest still matches; garbage payloads are refused", () => {
	const payload = goodPayload();
	const standard = Buffer.from(SIGNING_KEY_SHA256.replace(/:/g, ""), "hex").toString("base64");
	payload.appIntegrity.certificateSha256Digest = [standard];
	assert.equal(reasonOf(payload), "ok");
	assert.equal(reasonOf(undefined), "package");
	assert.equal(reasonOf("nope"), "package");
});

// ---- reCAPTCHA verdicts ----

const goodAssessment = (hostname = "helphive.himaiz.com", score = 0.9) => ({
	tokenProperties: { valid: true, action: "client_attest", hostname },
	riskAnalysis: { score },
});
const recaptchaReason = (assessment: unknown, min = 0.5) => {
	const verdict = evaluateRecaptchaAssessment(assessment, min);
	return verdict.ok ? "ok" : verdict.reason;
};

test("recaptcha: good assessment, score threshold boundary; previews never, localhost only in development", () => {
	const nodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	assert.equal(recaptchaReason(goodAssessment()), "ok");
	assert.equal(recaptchaReason(goodAssessment("helphive.himaiz.com", 0.5)), "ok");
	assert.equal(recaptchaReason(goodAssessment("HelpHive.HiMaiz.com")), "ok");
	assert.equal(recaptchaReason(goodAssessment("helphivenow.web.app")), "recaptcha_hostname", "retired Firebase site");
	assert.equal(recaptchaReason(goodAssessment("helphivenow--pr-42-abc123.web.app")), "recaptcha_hostname");
	assert.equal(recaptchaReason(goodAssessment("localhost")), "recaptcha_hostname");
	process.env.NODE_ENV = "development";
	assert.equal(recaptchaReason(goodAssessment("localhost")), "ok");
	assert.equal(recaptchaReason(goodAssessment("helphivenow--pr-42-abc123.web.app")), "recaptcha_hostname");
	process.env.NODE_ENV = nodeEnv;
});

test("recaptcha: invalid token, wrong action, low or missing score", () => {
	const invalid = { ...goodAssessment(), tokenProperties: { valid: false, invalidReason: "EXPIRED" } };
	const verdict = evaluateRecaptchaAssessment(invalid, 0.5);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.summary.invalidReason, "EXPIRED");
	assert.equal(recaptchaReason(invalid), "recaptcha_invalid");
	const action = goodAssessment();
	action.tokenProperties.action = "login";
	assert.equal(recaptchaReason(action), "recaptcha_action");
	assert.equal(recaptchaReason(goodAssessment("helphive.himaiz.com", 0.49)), "recaptcha_score");
	assert.equal(recaptchaReason({ tokenProperties: goodAssessment().tokenProperties }), "recaptcha_score");
	assert.equal(recaptchaReason(null), "recaptcha_invalid");
});

test("recaptcha: look-alike and foreign hostnames are refused", () => {
	for (const host of [
		"helphivenow.web.app.evil.com",
		"evil-helphivenow.web.app",
		"evilhelphive.himaiz.com",
		"helphive.himaiz.com.evil.com",
		"helphivenow--x.web.app.evil.com",
		"helphivenow--.evil.com",
		"example.com",
		"",
	]) {
		assert.equal(isAllowedWebHostname(host), false, host);
		assert.equal(recaptchaReason(goodAssessment(host)), "recaptcha_hostname", host);
	}
	assert.equal(isAllowedWebHostname(undefined), false);
});

// ---- Pass ----

test("pass: round trip carries the contract claims and TTL", () => {
	const { pass, expiresAt } = signPass(
		SECRET,
		{ platform: "android", deviceId: DEVICE, ttlSeconds: 3600 },
		Date.now(),
	);
	const claims = jwt.decode(pass) as jwt.JwtPayload;
	assert.equal(claims.typ, "client-pass");
	assert.equal(claims.plt, "android");
	assert.equal(claims.did, DEVICE);
	assert.equal(claims.aud, "helphive-client");
	assert.equal("dbg" in claims, false);
	assert.equal(claims.exp! - claims.iat!, 3600);
	assert.equal(expiresAt, claims.exp! * 1000);
	assert.deepEqual(verifyPass(pass, SECRET, DEVICE), { outcome: "valid", platform: "android" });
	const debugPass = signPass(SECRET, { platform: "web", deviceId: DEVICE, debug: true, ttlSeconds: 60 });
	assert.equal((jwt.decode(debugPass.pass) as jwt.JwtPayload).dbg, true);
});

test("pass: missing, expired, device mismatch, wrong secret, wrong aud, wrong typ, alg none", () => {
	assert.equal(verifyPass(undefined, SECRET, DEVICE).outcome, "missing");
	assert.equal(verifyPass("", SECRET, DEVICE).outcome, "missing");
	assert.equal(verifyPass("garbage", SECRET, DEVICE).outcome, "invalid");

	const old = signPass(SECRET, { platform: "web", deviceId: DEVICE, ttlSeconds: 60 }, Date.now() - 120_000);
	assert.equal(verifyPass(old.pass, SECRET, DEVICE).outcome, "expired");

	const fresh = signPass(SECRET, { platform: "web", deviceId: DEVICE, ttlSeconds: 60 }).pass;
	assert.equal(verifyPass(fresh, SECRET, "another-device-1").outcome, "device_mismatch");
	assert.equal(verifyPass(fresh, SECRET, undefined).outcome, "device_mismatch");
	assert.equal(verifyPass(fresh, "x".repeat(40), DEVICE).outcome, "invalid");

	const claims = { typ: "client-pass", plt: "web", did: DEVICE, aud: "helphive-client" };
	assert.equal(
		verifyPass(jwt.sign({ ...claims, aud: "other" }, SECRET, { expiresIn: 60 }), SECRET, DEVICE).outcome,
		"invalid",
	);
	assert.equal(
		verifyPass(jwt.sign({ ...claims, typ: "access" }, SECRET, { expiresIn: 60 }), SECRET, DEVICE).outcome,
		"invalid",
	);
	assert.equal(
		verifyPass(jwt.sign(claims, SECRET, { expiresIn: 60, algorithm: "HS512" }), SECRET, DEVICE).outcome,
		"invalid",
	);

	const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 60 })}.`;
	assert.equal(verifyPass(none, SECRET, DEVICE).outcome, "invalid");
});

// ---- Debug tokens ----

const DEBUG_A = "a".repeat(32);
const DEBUG_B = "b".repeat(40);

test("debug tokens: configured ones match, others do not, short configured ones are ignored", () => {
	const configured = debugTokens(` ${DEBUG_A} , ${DEBUG_B},short,`);
	assert.deepEqual(configured, [DEBUG_A, DEBUG_B]);
	assert.equal(isDebugToken(DEBUG_A, configured), true);
	assert.equal(isDebugToken(DEBUG_B, configured), true);
	assert.equal(isDebugToken("c".repeat(32), configured), false);
	assert.equal(isDebugToken(DEBUG_A.slice(0, 31), configured), false);
	assert.equal(isDebugToken("anything", []), false);
	assert.deepEqual(debugTokens("short,tiny"), []);
	assert.deepEqual(debugTokens(undefined), []);
});

// ---- HTTP harness ----

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
};

const serve = async (build: (app: express.Express) => void) => {
	const app = express();
	app.use(express.json());
	app.use("/client-attest", attestBodyError);
	build(app);
	const server = app.listen(0);
	await new Promise((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { base, close: () => new Promise((resolve) => server.close(resolve)) };
};

// ---- Middleware ----

test("middleware: off never checks; log never blocks but logs; enforce answers 428", async () => {
	const app = await serve((a) => {
		a.use(["/auth", "/email", "/public"], clientPassGuard);
		a.all("/auth/*", (_req, res) => res.json({ ok: true, outcome: res.locals.clientPass?.outcome ?? null }));
		a.all("/email/*", (_req, res) => res.json({ ok: true }));
		a.all("/public/*", (_req, res) => res.json({ ok: true }));
		a.all("/admin/*", (_req, res) => res.json({ ok: true }));
		a.post("/client-errors", (_req, res) => res.json({ ok: true }));
	});
	try {
		const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
			fetch(app.base + path, init);
		const goodPass = signPass(SECRET, { platform: "web", deviceId: DEVICE, ttlSeconds: 300 }).pass;
		const headers = { "X-Device-Id": DEVICE, "X-App-Platform": "web" };

		await withEnv({ CLIENT_ATTEST_MODE: "off", CLIENT_PASS_SECRET: SECRET }, async () => {
			logged.length = 0;
			assert.equal((await call("/auth/login", { method: "POST" })).status, 200);
			assert.equal(logged.length, 0);
		});

		await withEnv({ CLIENT_ATTEST_MODE: "log", CLIENT_PASS_SECRET: SECRET }, async () => {
			logged.length = 0;
			const response = await call("/public/things", { headers });
			assert.equal(response.status, 200);
			assert.equal(logged.length, 1);
			const entry = JSON.parse(logged[0]);
			assert.equal(entry.details.outcome, "missing");
			assert.equal(entry.details.method, "GET");
			assert.equal(entry.details.path, "/public/things");
			assert.equal(entry.details.appPlatform, "web");
			assert.doesNotMatch(logged[0], /X-Client-Pass/i);
			logged.length = 0;
			const valid = await call("/auth/login", { headers: { ...headers, "X-Client-Pass": goodPass } });
			assert.deepEqual(await valid.json(), { ok: true, outcome: "valid" });
			assert.equal(logged.length, 0);
		});

		await withEnv({ CLIENT_ATTEST_MODE: "enforce", CLIENT_PASS_SECRET: SECRET }, async () => {
			for (const path of ["/auth/login", "/email/send", "/public/things"]) {
				const missing = await call(path, { method: "POST", headers });
				assert.equal(missing.status, 428, path);
				assert.deepEqual(await missing.json(), { code: "CLIENT_PASS_REQUIRED" });
				assert.equal(
					(await call(path, { method: "POST", headers: { ...headers, "X-Client-Pass": goodPass } })).status,
					200,
				);
			}
			const mismatch = await call("/auth/login", {
				headers: { "X-Device-Id": "other-device-1", "X-Client-Pass": goodPass },
			});
			assert.equal(mismatch.status, 428);
			const expired = signPass(
				SECRET,
				{ platform: "web", deviceId: DEVICE, ttlSeconds: 60 },
				Date.now() - 120_000,
			).pass;
			assert.equal(
				(await call("/auth/login", { headers: { ...headers, "X-Client-Pass": expired } })).status,
				428,
			);
			assert.equal((await call("/auth/login", { headers: { ...headers, "X-Client-Pass": "junk" } })).status, 428);

			// Exempt: preflight, email-link pages, other prefixes.
			assert.equal((await call("/auth/login", { method: "OPTIONS" })).status, 200);
			assert.equal((await call("/public/things", { method: "OPTIONS" })).status, 200);
			assert.equal((await call("/auth/verify-email?token=abc")).status, 200);
			assert.equal((await call("/auth/Verify-Email/")).status, 200);
			assert.equal((await call("/auth/reset-password")).status, 200);
			assert.equal((await call("/auth/reset-password", { method: "POST" })).status, 200);
			assert.equal((await call("/auth/reset-password/style.css")).status, 200);
			assert.equal((await call("/admin/anything", { method: "POST" })).status, 200);
			assert.equal((await call("/client-errors", { method: "POST" })).status, 200);
			// Only GET verify-email is exempt; other paths that merely start alike are not.
			assert.equal((await call("/auth/verify-email", { method: "POST" })).status, 428);
			assert.equal((await call("/auth/reset-password-now", { method: "POST" })).status, 428);
			assert.equal((await call("/auth/verify-email/x", { method: "POST" })).status, 428);
		});
	} finally {
		await app.close();
	}
});

test("middleware: without a usable secret, enforce only logs (and logs the error once)", async () => {
	const app = await serve((a) => {
		a.use("/auth", clientPassGuard);
		a.all("/auth/*", (_req, res) => res.json({ ok: true }));
	});
	try {
		await withEnv({ CLIENT_ATTEST_MODE: "enforce", CLIENT_PASS_SECRET: "too-short" }, async () => {
			logged.length = 0;
			assert.equal((await fetch(`${app.base}/auth/login`)).status, 200);
			assert.equal((await fetch(`${app.base}/auth/login`, { headers: { "X-Client-Pass": "x" } })).status, 200);
			const errors = logged.map((line) => JSON.parse(line)).filter((entry) => entry.severity === "ERROR");
			assert.ok(errors.length <= 1);
		});
	} finally {
		await app.close();
	}
});

// ---- Route ----

const ENV = {
	CLIENT_ATTEST_MODE: "enforce",
	CLIENT_PASS_SECRET: SECRET,
	RECAPTCHA_SITE_KEY: "site-key",
	ATTEST_DEBUG_TOKENS: DEBUG_A,
	CLIENT_PASS_TTL_ANDROID_SEC: undefined,
	CLIENT_PASS_TTL_WEB_SEC: undefined,
	RECAPTCHA_MIN_SCORE: undefined,
};

const mockGoogle = () => {
	const calls = { decode: 0, assess: 0 };
	const state: { decode: () => Promise<unknown>; assess: () => Promise<unknown> } = {
		decode: async () => ({ tokenPayloadExternal: goodPayload() }),
		assess: async () => goodAssessment(),
	};
	const google: AttestGoogle = {
		decodeIntegrityToken: async () => {
			calls.decode++;
			return state.decode();
		},
		createAssessment: async () => {
			calls.assess++;
			return state.assess();
		},
	};
	return { calls, state, google };
};

const attest = async (base: string, body: unknown, deviceHeader: string | null = DEVICE) => {
	const response = await fetch(`${base}/client-attest`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(deviceHeader ? { "X-Device-Id": deviceHeader } : {}) },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json().catch(() => null)) as any };
};

test("route: android, web and debug proofs get a pass; Google failures map to 403/503", async () => {
	const mock = mockGoogle();
	const app = await serve((a) =>
		a.post(
			"/client-attest",
			createClientAttestHandler(mock.google, () => NOW),
		),
	);
	try {
		await withEnv(ENV, async () => {
			const android = await attest(app.base, { platform: "android", deviceId: DEVICE, integrityToken: "tok" });
			assert.equal(android.status, 200);
			assert.equal(android.body.expiresAt, (Math.floor(NOW / 1000) + 3600) * 1000);
			const claims = jwt.decode(android.body.pass) as jwt.JwtPayload;
			assert.equal(claims.plt, "android");
			assert.equal(claims.did, DEVICE);

			const web = await attest(app.base, { platform: "web", deviceId: DEVICE, recaptchaToken: "tok" });
			assert.equal(web.status, 200);
			assert.equal(web.body.expiresAt, (Math.floor(NOW / 1000) + 43200) * 1000);

			const debug = await attest(app.base, { platform: "android", deviceId: DEVICE, debugToken: DEBUG_A });
			assert.equal(debug.status, 200);
			assert.equal((jwt.decode(debug.body.pass) as jwt.JwtPayload).dbg, true);

			// Verdict failure: 403 with the reason.
			const bad = goodPayload();
			bad.deviceIntegrity.deviceRecognitionVerdict = [];
			mock.state.decode = async () => ({ tokenPayloadExternal: bad });
			assert.deepEqual(
				(await attest(app.base, { platform: "android", deviceId: DEVICE, integrityToken: "tok" })).body,
				{
					code: "CLIENT_ATTESTATION_FAILED",
					reason: "device_integrity",
				},
			);
			mock.state.assess = async () => goodAssessment("helphive.himaiz.com", 0.1);
			const low = await attest(app.base, { platform: "web", deviceId: DEVICE, recaptchaToken: "tok" });
			assert.equal(low.status, 403);
			assert.equal(low.body.reason, "recaptcha_score");

			// Google refuses the token itself (400): 403. Network error or 5xx: 503.
			mock.state.decode = async () => {
				throw new GoogleCallError("bad token", 400);
			};
			const decodeFailed = await attest(app.base, {
				platform: "android",
				deviceId: DEVICE,
				integrityToken: "tok",
			});
			assert.equal(decodeFailed.status, 403);
			assert.equal(decodeFailed.body.reason, "decode_failed");
			mock.state.decode = async () => {
				throw new GoogleCallError("connect ECONNRESET");
			};
			const network = await attest(app.base, { platform: "android", deviceId: DEVICE, integrityToken: "tok" });
			assert.equal(network.status, 503);
			assert.deepEqual(network.body, { code: "CLIENT_ATTESTATION_UNAVAILABLE" });
			mock.state.assess = async () => {
				throw new GoogleCallError("backend error", 500);
			};
			assert.equal(
				(await attest(app.base, { platform: "web", deviceId: DEVICE, recaptchaToken: "tok" })).status,
				503,
			);
			mock.state.assess = async () => {
				throw new GoogleCallError("permission denied", 403);
			};
			assert.equal(
				(await attest(app.base, { platform: "web", deviceId: DEVICE, recaptchaToken: "tok" })).status,
				503,
			);
		});
	} finally {
		await app.close();
	}
});

test("route: CLIENT_PASS_TTL_WEB_SEC sets the web pass lifetime", async () => {
	const mock = mockGoogle();
	const app = await serve((a) =>
		a.post(
			"/client-attest",
			createClientAttestHandler(mock.google, () => NOW),
		),
	);
	try {
		await withEnv({ ...ENV, CLIENT_PASS_TTL_WEB_SEC: "120" }, async () => {
			mock.state.assess = async () => goodAssessment("helphive.himaiz.com");
			const result = await attest(app.base, { platform: "web", deviceId: DEVICE, recaptchaToken: "tok" });
			assert.equal(result.status, 200);
			assert.equal(result.body.expiresAt, (Math.floor(NOW / 1000) + 120) * 1000);
		});
	} finally {
		await app.close();
	}
});

test("route: 400 on malformed bodies and on a device id that differs from X-Device-Id", async () => {
	const mock = mockGoogle();
	const app = await serve((a) =>
		a.post(
			"/client-attest",
			createClientAttestHandler(mock.google, () => NOW),
		),
	);
	try {
		await withEnv(ENV, async () => {
			const bad: unknown[] = [
				"not json",
				[],
				{},
				{ platform: "ios", deviceId: DEVICE, integrityToken: "t" },
				{ platform: "android", deviceId: "short", integrityToken: "t" },
				{ platform: "android", deviceId: "has space in it", integrityToken: "t" },
				{ platform: "android", deviceId: "x".repeat(129), integrityToken: "t" },
				{ platform: "android", deviceId: DEVICE },
				{ platform: "android", deviceId: DEVICE, integrityToken: "" },
				{ platform: "android", deviceId: DEVICE, integrityToken: 5 },
				{ platform: "android", deviceId: DEVICE, integrityToken: "t", debugToken: DEBUG_A },
				{ platform: "android", deviceId: DEVICE, recaptchaToken: "t" },
				{ platform: "web", deviceId: DEVICE, integrityToken: "t" },
			];
			for (const body of bad) {
				const result = await attest(app.base, body);
				assert.equal(result.status, 400, JSON.stringify(body));
				assert.deepEqual(result.body, { code: "BAD_REQUEST" });
			}
			const valid = { platform: "android", deviceId: DEVICE, integrityToken: "tok" };
			assert.equal((await attest(app.base, valid, "different-device-1")).status, 400);
			assert.equal((await attest(app.base, valid, null)).status, 400);
			assert.equal(mock.calls.decode, 0);
		});
	} finally {
		await app.close();
	}
});

test("route: 503 when mode is off, the secret is unusable or the web site key is missing", async () => {
	const mock = mockGoogle();
	const app = await serve((a) =>
		a.post(
			"/client-attest",
			createClientAttestHandler(mock.google, () => NOW),
		),
	);
	const body = { platform: "android", deviceId: DEVICE, integrityToken: "tok" };
	try {
		for (const env of [
			{ ...ENV, CLIENT_ATTEST_MODE: "off" },
			{ ...ENV, CLIENT_ATTEST_MODE: undefined },
			{ ...ENV, CLIENT_PASS_SECRET: undefined },
			{ ...ENV, CLIENT_PASS_SECRET: "short" },
		]) {
			await withEnv(env, async () => {
				const result = await attest(app.base, body);
				assert.equal(result.status, 503);
				assert.deepEqual(result.body, { code: "CLIENT_ATTESTATION_UNAVAILABLE" });
			});
		}
		await withEnv({ ...ENV, RECAPTCHA_SITE_KEY: undefined }, async () => {
			assert.equal(
				(await attest(app.base, { platform: "web", deviceId: DEVICE, recaptchaToken: "t" })).status,
				503,
			);
			// Android and debug proofs do not need the site key.
			assert.equal((await attest(app.base, body)).status, 200);
		});
		assert.equal(mock.calls.assess, 0);
	} finally {
		await app.close();
	}
});

test("route: log mode also issues passes", async () => {
	const mock = mockGoogle();
	const app = await serve((a) => a.post("/client-attest", createClientAttestHandler(mock.google)));
	try {
		await withEnv({ ...ENV, CLIENT_ATTEST_MODE: "log" }, async () => {
			// Real clock here, so a debug proof is used (the Android fixtures are relative to a fixed NOW).
			const result = await attest(app.base, { platform: "web", deviceId: DEVICE, debugToken: DEBUG_A });
			assert.equal(result.status, 200);
			assert.deepEqual(verifyPass(result.body.pass, SECRET, DEVICE), { outcome: "valid", platform: "web" });
		});
	} finally {
		await app.close();
	}
});

test("route: debug tokens accepted, wrong or short ones refused, none configured refuses", async () => {
	const mock = mockGoogle();
	const app = await serve((a) => a.post("/client-attest", createClientAttestHandler(mock.google)));
	const send = (token: string, platform = "android") =>
		attest(app.base, { platform, deviceId: DEVICE, debugToken: token });
	try {
		await withEnv({ ...ENV, ATTEST_DEBUG_TOKENS: `${DEBUG_A},${DEBUG_B}` }, async () => {
			assert.equal((await send(DEBUG_A)).status, 200);
			assert.equal((await send(DEBUG_B, "web")).status, 200);
			const wrong = await send("c".repeat(32));
			assert.equal(wrong.status, 403);
			assert.deepEqual(wrong.body, { code: "CLIENT_ATTESTATION_FAILED", reason: "debug_token" });
		});
		await withEnv({ ...ENV, ATTEST_DEBUG_TOKENS: "tooshort" }, async () => {
			assert.equal((await send("tooshort")).status, 403);
		});
		await withEnv({ ...ENV, ATTEST_DEBUG_TOKENS: undefined }, async () => {
			assert.equal((await send(DEBUG_A)).status, 403);
		});
		assert.equal(mock.calls.decode + mock.calls.assess, 0);
		assert.doesNotMatch(logged.join("\n"), new RegExp(DEBUG_A));
	} finally {
		await app.close();
	}
});
