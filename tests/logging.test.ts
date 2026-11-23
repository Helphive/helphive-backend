// Run with: npx ts-node tests/logging.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildLogEntry,
	buildRequestLogEntry,
	log,
	requestSeverity,
	serializeError,
	setLogSink,
	writeEntry,
} from "../lib/logger";
import {
	buildRequestContext,
	getRequestContext,
	parseClientHeaders,
	parseRay,
	parseTraceHeader,
	resolveRequestId,
} from "../lib/requestContext";
import { markRouteBase, requestContext } from "../middleware/requestContext";
import { parseDuration } from "../lib/duration";

const TRACE = "105445aa7843bc8bf206b12000100000";
const RAY = "8a1b2c3d4e5f6a7b-LHR";

test("client headers: valid values kept (platform lower-cased), anything odd dropped rather than rejected", () => {
	assert.deepEqual(
		parseClientHeaders({ "x-app-platform": "iOS", "x-app-version": "2.3.1+57", "x-device-id": "A1B2-c3d4:e5" }),
		{
			platform: "ios",
			appVersion: "2.3.1+57",
			deviceId: "A1B2-c3d4:e5",
		},
	);
	const hostile = parseClientHeaders({
		"x-app-platform": "<script>",
		"x-app-version": "1".repeat(40),
		"x-device-id": "id with spaces",
	});
	assert.deepEqual(hostile, { platform: undefined, appVersion: undefined, deviceId: undefined });
	assert.deepEqual(parseClientHeaders({}), { platform: undefined, appVersion: undefined, deviceId: undefined });
	assert.equal(parseClientHeaders({ "x-device-id": "x".repeat(129) }).deviceId, undefined);
	assert.equal(parseClientHeaders({ "x-app-platform": ["android", "ios"] }).platform, "android");
});

test("request id: a well-formed client id is kept, otherwise a fresh UUID", () => {
	assert.equal(resolveRequestId("client-req-0001"), "client-req-0001");
	assert.match(resolveRequestId(undefined), /^[0-9a-f-]{36}$/);
	assert.match(resolveRequestId("short"), /^[0-9a-f-]{36}$/);
	assert.match(resolveRequestId("bad id\nwith newline"), /^[0-9a-f-]{36}$/);
});

test("trace: X-Cloud-Trace-Context becomes the Cloud Logging trace field", () => {
	assert.deepEqual(parseTraceHeader(`${TRACE}/1;o=1`, "helphive"), {
		trace: `projects/helphive/traces/${TRACE}`,
		spanId: "1",
		traceSampled: true,
	});
	assert.deepEqual(parseTraceHeader(TRACE, "helphive"), { trace: `projects/helphive/traces/${TRACE}` });
	assert.deepEqual(parseTraceHeader("garbage", "helphive"), {});
	assert.deepEqual(parseTraceHeader(undefined, "helphive"), {});
});

test("ray: X-CF-Ray from the edge Worker, else CF-Ray; anything malformed is dropped", () => {
	assert.equal(parseRay({ "x-cf-ray": RAY, "cf-ray": "1111111111111111-IAD" }), RAY);
	assert.equal(parseRay({ "cf-ray": RAY }), RAY);
	assert.equal(parseRay({ "x-cf-ray": "8a1b2c3d4e5f6a7b" }), "8a1b2c3d4e5f6a7b");
	assert.equal(parseRay({ "x-cf-ray": "not a ray {}" }), undefined);
	assert.equal(parseRay({}), undefined);
});

test("log entry: standard fields in order, context, trace, error reduced to name/message/code/stack, emails masked", () => {
	const context = {
		...buildRequestContext(
			{
				"x-cloud-trace-context": `${TRACE}/7;o=1`,
				"x-app-platform": "android",
				"x-app-version": "1.0",
				"x-cf-ray": RAY,
			},
			"1.2.3.4",
			"helphive",
		),
		route: "/auth/login",
		actor: { type: "user" as const, id: "64b7f0c2a1b2c3d4e5f60718" },
	};
	const error = Object.assign(new Error("lookup failed for jane@example.com"), {
		code: "ECONNRESET",
		config: { headers: { Authorization: "Basic secret" } },
	});
	const entry = buildLogEntry(
		"ERROR",
		"stripe_call_failed",
		"Could not reach jane.doe@example.com",
		[error, { token: "t", status: 502 }],
		context,
		new Date("2026-11-19T00:00:00Z"),
	);
	assert.deepEqual(Object.keys(entry).slice(0, 8), [
		"time",
		"level",
		"app",
		"part",
		"event",
		"ray",
		"msg",
		"severity",
	]);
	assert.equal(entry.level, "error");
	assert.equal(entry.severity, "ERROR");
	assert.equal(entry.app, "helphive");
	assert.equal(entry.part, "api");
	assert.equal(entry.event, "stripe_call_failed");
	assert.equal(entry.ray, RAY);
	assert.equal(entry.msg, "Could not reach j***@example.com");
	assert.equal("message" in entry, false);
	assert.equal(entry.time, "2026-11-19T00:00:00.000Z");
	assert.equal(entry.requestId, context.requestId);
	assert.equal(entry.route, "/auth/login");
	assert.equal(entry.userId, "64b7f0c2a1b2c3d4e5f60718");
	assert.equal(entry.appPlatform, "android");
	assert.equal(entry.appVersion, "1.0");
	assert.equal(entry["logging.googleapis.com/trace"], `projects/helphive/traces/${TRACE}`);
	assert.equal(entry["logging.googleapis.com/spanId"], "7");
	assert.equal(entry.error?.code, "ECONNRESET");
	assert.equal(entry.error?.message, "lookup failed for j***@example.com");
	assert.ok(entry.error?.stack?.includes("Error"));
	assert.equal(JSON.stringify(entry).includes("Basic secret"), false, "axios-style config is never logged");
	assert.deepEqual(entry.details, { token: "[redacted]", status: 502 });
	const admin = buildLogEntry("INFO", "x", "x", [], { requestId: "r", actor: { type: "admin", id: "a1" } });
	assert.equal(admin.adminId, "a1");
	assert.equal(admin.level, "info");
	assert.equal(admin.ray, undefined, "no ray outside Cloudflare");
	assert.equal(buildLogEntry("WARNING", "x", "x", [], undefined).level, "warn");
	assert.equal(buildLogEntry("CRITICAL", "x", "x", [], undefined).level, "error");
	assert.equal(admin.userId, undefined);
	assert.deepEqual(serializeError("plain"), { message: "plain" });
});

test("request line: route pattern (never the raw URL), status, ms, user id; levels by status and path", () => {
	const context = {
		...buildRequestContext({ "user-agent": "Mozilla/5.0", "x-cf-ray": RAY }, "203.0.113.7", "helphive"),
		route: "/auth/verify-email",
		actor: { type: "user" as const, id: "64b7f0c2a1b2c3d4e5f60718" },
	};
	const entry = buildRequestLogEntry(
		{ method: "GET", path: "/auth/verify-email/SECRET", status: 400, latencyMs: 42.4 },
		context,
		new Date("2026-11-23T00:00:00Z"),
	);
	assert.deepEqual(
		{ ...entry, requestId: "r" },
		{
			time: "2026-11-23T00:00:00.000Z",
			level: "info",
			app: "helphive",
			part: "api",
			event: "request",
			ray: RAY,
			msg: "GET /auth/verify-email 400",
			severity: "INFO",
			requestId: "r",
			route: "/auth/verify-email",
			userId: "64b7f0c2a1b2c3d4e5f60718",
			method: "GET",
			status: 400,
			ms: 42,
		},
	);
	const raw = JSON.stringify(entry);
	for (const leak of ["SECRET", "203.0.113.7", "Mozilla"]) assert.equal(raw.includes(leak), false, leak);
	assert.equal(requestSeverity({ method: "GET", path: "/x", status: 503 }), "ERROR");
	assert.equal(requestSeverity({ method: "GET", path: "/readyz", status: 200 }), "DEBUG");
	assert.equal(requestSeverity({ method: "OPTIONS", path: "/auth/login", status: 204 }), "DEBUG");
	assert.equal(requestSeverity({ method: "POST", path: "/auth/login", status: 401 }), "INFO");
	const unmatched = buildRequestLogEntry(
		{ method: "GET", path: "/wp-admin/x", status: 404, latencyMs: 1 },
		undefined,
	);
	assert.equal(unmatched.route, "/wp-admin/*", "no route matched: first path segment only");
	assert.equal(unmatched.msg, "GET /wp-admin/* 404");
	const guarded = buildRequestLogEntry(
		{ method: "POST", path: "/auth/reset/64b7f0c2a1b2c3d4e5f60718/token", status: 428, latencyMs: 1 },
		{ requestId: "r" },
	);
	assert.equal(guarded.route, "/auth/*", "rejected before routing");
	const catchAll = buildRequestLogEntry(
		{ method: "GET", path: "/nope/x", status: 404, latencyMs: 1 },
		{ requestId: "r", route: "*" },
	);
	assert.equal(catchAll.route, "/nope/*");
	assert.equal(buildRequestLogEntry({ method: "GET", path: "/", status: 200, latencyMs: 1 }, undefined).route, "/");
});

test("LOG_LEVEL drops lines below it (default info)", () => {
	const lines: string[] = [];
	const previous = setLogSink((line) => lines.push(line));
	const saved = process.env.LOG_LEVEL;
	try {
		delete process.env.LOG_LEVEL;
		log.debug("probe", "hidden");
		log.info("startup", "shown");
		process.env.LOG_LEVEL = "debug";
		log.debug("probe", "shown now");
		process.env.LOG_LEVEL = "error";
		log.warn("odd", "hidden");
		writeEntry(buildLogEntry("ERROR", "exception", "shown", [], undefined));
		assert.deepEqual(
			lines.map((line) => JSON.parse(line).msg),
			["shown", "shown now", "shown"],
		);
	} finally {
		if (saved === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = saved;
		setLogSink(previous);
	}
});

test("middleware: X-Request-Id on every response, requestId added to JSON error bodies, one request line", () => {
	const lines: any[] = [];
	const previous = setLogSink((line) => lines.push(JSON.parse(line)));
	const headers: Record<string, string> = {};
	const listeners: Record<string, () => void> = {};
	let sent: unknown;
	const res: any = {
		statusCode: 404,
		setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value),
		getHeader: (name: string) => headers[name.toLowerCase()],
		json: (body: unknown) => ((sent = body), res),
		end: () => res,
		on: (event: string, fn: () => void) => (listeners[event] = fn),
	};
	const req: any = {
		headers: { "x-app-platform": "web", "x-cf-ray": RAY },
		ip: "198.51.100.4",
		method: "GET",
		path: "/admin/nothing",
		originalUrl: "/admin/nothing?x=1",
		httpVersion: "1.1",
		baseUrl: "/admin",
		route: { path: "/nothing" },
	};
	let inside: unknown;
	requestContext(req, res, () => {
		inside = getRequestContext();
	});
	assert.ok(headers["x-request-id"]);
	assert.equal((inside as any)?.requestId, headers["x-request-id"], "context available to handlers");
	res.json({ message: "Not found" });
	assert.deepEqual(sent, { message: "Not found", requestId: headers["x-request-id"] });
	res.statusCode = 200;
	res.json({ ok: true });
	assert.deepEqual(sent, { ok: true }, "success bodies unchanged");
	res.json(["array", "unchanged"]);
	listeners.finish();
	assert.equal(lines.length, 1);
	assert.equal(lines[0].event, "request");
	assert.equal(lines[0].ray, RAY);
	assert.equal(lines[0].route, "/admin/nothing");
	assert.equal(lines[0].status, 200);
	assert.equal(lines[0].appPlatform, "web");
	assert.equal(JSON.stringify(lines[0]).includes("x=1"), false, "no query string");

	// Health probes are logged at debug, so the default LOG_LEVEL=info leaves them out.
	lines.length = 0;
	const quietReq = { ...req, path: "/healthz", originalUrl: "/healthz", route: undefined };
	const quietRes = { ...res, statusCode: 200 };
	requestContext(quietReq, quietRes, () => undefined);
	listeners.finish();
	assert.equal(lines.length, 0);
	setLogSink(previous);
});

test("error lines keep the router prefix after Express resets baseUrl (markRouteBase)", () => {
	const lines: any[] = [];
	const previous = setLogSink((line) => lines.push(JSON.parse(line)));
	const headers: Record<string, string> = {};
	const listeners: Record<string, () => void> = {};
	const res: any = {
		statusCode: 200,
		setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value),
		getHeader: (name: string) => headers[name.toLowerCase()],
		json: () => res,
		end: () => res,
		on: (event: string, fn: () => void) => (listeners[event] = fn),
	};
	const req: any = { headers: {}, ip: "198.51.100.4", method: "POST", path: "/auth/login", baseUrl: "" };
	requestContext(req, res, () => undefined);
	// Inside the auth router: Express sets baseUrl, the router's first middleware records it, the route matches.
	req.baseUrl = "/auth";
	markRouteBase(req, res, () => undefined);
	req.route = { path: "/login" };
	// The handler fails; Express leaves the router (baseUrl reset) and the app error handler answers.
	req.baseUrl = "";
	res.statusCode = 500;
	res.json({ message: "Internal Server Error" });
	listeners.finish();
	assert.equal(lines.length, 1);
	assert.equal(lines[0].route, "/auth/login");
	assert.equal(lines[0].level, "error");

	// A router that matched nothing, then the app-level catch-all 404: the coarse route, not "/auth*".
	lines.length = 0;
	const req404: any = { headers: {}, ip: "198.51.100.4", method: "GET", path: "/auth/nothing", baseUrl: "" };
	const res404: any = { ...res, statusCode: 404 };
	requestContext(req404, res404, () => undefined);
	req404.baseUrl = "/auth";
	markRouteBase(req404, res404, () => undefined);
	req404.baseUrl = "";
	req404.route = { path: "*" };
	res404.json({ message: "Not found" });
	listeners.finish();
	assert.equal(lines[0].route, "/auth/*");
	setLogSink(previous);
});

test("durations from the environment", () => {
	assert.equal(parseDuration("8h"), 8 * 3600 * 1000);
	assert.equal(parseDuration("15m"), 15 * 60 * 1000);
	assert.equal(parseDuration("90"), 90 * 1000);
	assert.equal(parseDuration("7d"), 7 * 86400 * 1000);
	assert.equal(parseDuration("0m"), null);
	assert.equal(parseDuration("-5m"), null);
	assert.equal(parseDuration("eight hours"), null);
});
