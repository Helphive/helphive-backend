// Run with: node -r ts-node/register/transpile-only --test tests/newRoutes.test.ts
// Loads the route modules (no server, no database) and checks every route added for address lookup, chat and push:
// authentication first, then a rate limit, then validation, then the handler. Also runs the validators and the
// webhook guard against fake requests, and checks the admin chat routes' permissions and audit markers.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

delete process.env.DATABASE_URI;
mongoose.set("bufferCommands", false);
process.env.STRIPE_SECRET_KEY = "sk_test_wiring_only";

/* eslint-disable @typescript-eslint/no-require-imports */
const places = require("../routes/user-routes/places.route").default;
const chat = require("../routes/user-routes/chat.route").default;
const push = require("../routes/user-routes/push.route").default;
const auth = require("../routes/user-routes/auth.route").default;
const admin = require("../routes/admin.route").default;
const cometchat = require("../routes/webhook-routes/cometchat.route");
const cloudTasks = require("../routes/webhook-routes/cloudtasks.route").default;
const { verifyJWT } = require("../middleware/verifyJWT");
const limits = require("../middleware/rateLimit");
const { rejectIfInvalid, validateNoInput } = require("../controllers/user-controllers/validators/common.validators");
const placesValidators = require("../controllers/user-controllers/validators/places.validators");
const { verifyAdminJWT } = require("../middleware/verifyAdminJWT");
const { auditActionsOf } = require("../middleware/audited");
/* eslint-enable @typescript-eslint/no-require-imports */

type Route = { path: string; method: string; handles: any[] };

const routesOf = (router: any): Route[] =>
	router.stack
		.filter((layer: any) => layer.route)
		.map((layer: any) => ({
			path: layer.route.path,
			method: Object.keys(layer.route.methods)[0].toUpperCase(),
			handles: layer.route.stack.map((s: any) => s.handle),
		}));

const LIMITERS = new Set<unknown>([
	...limits.placesLimiters,
	limits.chatSessionLimiter,
	limits.chatReadLimiter,
	limits.chatWriteLimiter,
	limits.pushRegisterLimiter,
]);
const isValidation = (h: any) => h === rejectIfInvalid || h === validateNoInput || h?.name === "rejectWithCode";

const EXPECTED = {
	places: ["GET /status", "POST /autocomplete", "POST /details", "POST /reverse-geocode"],
	chat: [
		"POST /session",
		"POST /session/end",
		"GET /bookings/:bookingId/conversation",
		"PUT /viewing",
		"GET /contacts",
		"GET /unread-count",
		"POST /reports",
		"GET /blocks",
		"POST /blocks",
		"DELETE /blocks/:uid",
	],
	push: ["POST /register", "DELETE /register"],
};

test("every new user route: authentication, then a rate limit, then validation, then the handler", () => {
	for (const [name, router] of Object.entries({ places, chat, push })) {
		const routes = routesOf(router);
		assert.deepEqual(
			routes.map((r) => `${r.method} ${r.path}`),
			EXPECTED[name as keyof typeof EXPECTED],
			`${name} routes`,
		);
		for (const route of routes) {
			const id = `${name} ${route.method} ${route.path}`;
			assert.equal(route.handles[0], verifyJWT, `${id}: verifyJWT first`);
			assert.equal(typeof route.handles[1], "function", `${id}: role check second`);
			const limitAt = route.handles.findIndex((h) => LIMITERS.has(h));
			const validateAt = route.handles.findIndex(isValidation);
			assert.ok(limitAt >= 2, `${id}: rate limited after authentication`);
			assert.ok(validateAt > limitAt, `${id}: validated after the limit`);
			assert.equal(validateAt, route.handles.length - 2, `${id}: validation right before the handler`);
		}
	}
});

test("the new routers are mounted under /auth without changing existing routes", () => {
	const mounts = auth.stack.filter((layer: any) => !layer.route).map((layer: any) => String(layer.regexp));
	for (const prefix of ["places", "chat", "push"]) {
		assert.ok(
			mounts.some((m: string) => m.includes(`\\/${prefix}`)),
			`/auth/${prefix} mounted`,
		);
	}
	const paths = routesOf(auth).map((r) => `${r.method} ${r.path}`);
	for (const existing of ["POST /login", "POST /logout", "POST /refresh", "POST /profile", "GET /user-info"]) {
		assert.ok(paths.includes(existing), existing);
	}
});

test("CometChat webhook: rejected-call limiter, Basic auth, payload check, then the handler", () => {
	const [route] = routesOf(cometchat.default);
	assert.equal(`${route.method} ${route.path}`, "POST /");
	assert.equal(route.handles[0], cometchat.cometChatWebhookLimiter);
	assert.equal(route.handles[1], cometchat.verifyCometChatWebhook);
	assert.equal(route.handles[2], cometchat.validateCometChatPayload);
	const task = routesOf(cloudTasks).find((r) => r.path === "/chat-window");
	assert.ok(
		task && task.method === "POST" && task.handles.length >= 4,
		"chat-window task is guarded like the others",
	);
});

test("admin chat routes: permission, and audited writes", () => {
	const routes = routesOf(admin);
	const find = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path)!;
	const expected: [string, string, string, string | null][] = [
		["GET", "/chat/reports", "support.read", null],
		["GET", "/chat/reports/:id", "support.read", null],
		["POST", "/chat/reports/:id/resolve", "support.manage", "chat.report_resolved"],
		["POST", "/users/:id/chat-suspend", "users.manage", "users.chat_suspended"],
		["POST", "/users/:id/chat-reinstate", "users.manage", "users.chat_reinstated"],
		["GET", "/platform/settings", "account.self", null],
	];
	for (const [method, path, permission, action] of expected) {
		const route = find(method, path);
		assert.ok(route, `${method} ${path}`);
		assert.equal(route.handles[0], verifyAdminJWT);
		assert.equal(route.handles[1].permission, permission, `${method} ${path}`);
		if (action) assert.deepEqual(auditActionsOf(route.handles.at(-1)), [action]);
	}
});

// --- Validators and guards against fake requests -------------------------------------------------------------

const fakeRes = () => {
	const res: any = { statusCode: 200, body: undefined };
	res.status = (code: number) => ((res.statusCode = code), res);
	res.json = (body: unknown) => ((res.body = body), res);
	return res;
};

/** Runs middleware in order until one answers; true when the chain reached its end. */
const run = async (chain: any[], req: any) => {
	const res = fakeRes();
	for (const middleware of chain) {
		let nextCalled = false;
		await middleware(req, res, () => {
			nextCalled = true;
		});
		if (!nextCalled) return { passed: false, res };
	}
	return { passed: true, res };
};

const TOKEN = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

test("address validators: typed 400s for bad input, pass for good input", async () => {
	const ok = await run(placesValidators.validateAutocomplete, {
		body: { input: "savoy", sessionToken: TOKEN, near: { latitude: 51.5, longitude: -0.1 } },
	});
	assert.equal(ok.passed, true);
	for (const body of [
		{ input: "savoy" },
		{ input: "savoy", sessionToken: "bad token" },
		{ input: "", sessionToken: TOKEN },
		{ input: { $gt: "" }, sessionToken: TOKEN },
		{ input: "x".repeat(201), sessionToken: TOKEN },
		{ input: "x", sessionToken: TOKEN, near: { latitude: 91, longitude: 0 } },
		{ input: "x", sessionToken: TOKEN, regionCode: "GBR" },
	]) {
		const result = await run(placesValidators.validateAutocomplete, { body });
		assert.equal(result.passed, false, JSON.stringify(body));
		assert.equal(result.res.statusCode, 400);
		assert.equal(result.res.body.code, "places_invalid_request");
	}
	assert.equal((await run(placesValidators.validatePlaceDetails, { body: { placeId: "../x" } })).passed, false);
	assert.equal(
		(await run(placesValidators.validateReverseGeocode, { body: { latitude: 1, longitude: 181 } })).passed,
		false,
	);
	assert.equal((await run([validateNoInput], { query: { a: "1" }, body: {} })).passed, false);
	assert.equal((await run([validateNoInput], { query: {}, body: {} })).passed, true);
});

test("webhook guard: 503 until configured, 401 for wrong credentials, then the payload must have a trigger", async () => {
	const saved = { ...process.env };
	const header = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
	try {
		delete process.env.COMETCHAT_WEBHOOK_USERNAME;
		delete process.env.COMETCHAT_WEBHOOK_PASSWORD;
		const off = await run([cometchat.verifyCometChatWebhook], { headers: {} });
		assert.equal(off.res.statusCode, 503);
		process.env.COMETCHAT_WEBHOOK_USERNAME = "hook";
		process.env.COMETCHAT_WEBHOOK_PASSWORD = "p".repeat(30);
		const wrong = await run([cometchat.verifyCometChatWebhook], {
			headers: { authorization: header("hook", "x") },
		});
		assert.equal(wrong.res.statusCode, 401);
		const right = await run([cometchat.verifyCometChatWebhook, cometchat.validateCometChatPayload], {
			headers: { authorization: header("hook", "p".repeat(30)) },
			body: { trigger: "message_sent", data: {} },
		});
		assert.equal(right.passed, true);
		const bad = await run([cometchat.validateCometChatPayload], { body: [] });
		assert.equal(bad.res.statusCode, 400);
	} finally {
		process.env = saved;
	}
});
