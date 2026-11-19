// Run with: npx ts-node tests/logging.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildLogEntry,
	buildRequestLogEntry,
	pathOnly,
	serializeError,
	setLogSink,
	severityForStatus,
} from "../lib/logger";
import {
	buildRequestContext,
	getRequestContext,
	parseClientHeaders,
	parseTraceHeader,
	resolveRequestId,
} from "../lib/requestContext";
import { requestContext } from "../middleware/requestContext";
import { parseDuration } from "../lib/duration";

const TRACE = "105445aa7843bc8bf206b12000100000";

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

test("log entry: severity, message, context fields, trace, error reduced to name/message/code/stack, emails masked", () => {
	const context = {
		...buildRequestContext(
			{ "x-cloud-trace-context": `${TRACE}/7;o=1`, "x-app-platform": "android", "x-app-version": "1.0" },
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
		"Could not reach jane.doe@example.com",
		[error, { token: "t", status: 502 }],
		context,
		new Date("2026-11-19T00:00:00Z"),
	);
	assert.equal(entry.severity, "ERROR");
	assert.equal(entry.message, "Could not reach j***@example.com");
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
	const admin = buildLogEntry("INFO", "x", [], { requestId: "r", actor: { type: "admin", id: "a1" } });
	assert.equal(admin.adminId, "a1");
	assert.equal(admin.userId, undefined);
	assert.deepEqual(serializeError("plain"), { message: "plain" });
});

test("request log entry: Cloud Logging httpRequest shape, path without query string, status-based severity", () => {
	const context = {
		...buildRequestContext({ "user-agent": "Mozilla/5.0" }, "203.0.113.7", "helphive"),
		route: "/auth/verify-email",
	};
	const entry = buildRequestLogEntry(
		{
			method: "GET",
			originalUrl: "/auth/verify-email?token=SECRET",
			status: 400,
			latencyMs: 42.4,
			responseSize: 51,
			protocol: "HTTP/1.1",
		},
		context,
	);
	assert.equal(entry.severity, "WARNING");
	assert.equal(entry.message, "GET /auth/verify-email 400 42ms");
	assert.deepEqual(entry.httpRequest, {
		requestMethod: "GET",
		requestUrl: "/auth/verify-email",
		status: 400,
		latency: "0.042s",
		remoteIp: "203.0.113.7",
		userAgent: "Mozilla/5.0",
		responseSize: "51",
		protocol: "HTTP/1.1",
	});
	assert.equal(JSON.stringify(entry).includes("SECRET"), false);
	assert.equal(pathOnly("/a/b#frag"), "/a/b");
	assert.equal(severityForStatus(503), "ERROR");
	assert.equal(severityForStatus(201), "INFO");
});

test("middleware: X-Request-Id on every response, requestId added to JSON error bodies, one access-log line", () => {
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
		headers: { "x-app-platform": "web" },
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
	assert.equal(lines[0].httpRequest.requestUrl, "/admin/nothing");
	assert.equal(lines[0].route, "/admin/nothing");
	assert.equal(lines[0].appPlatform, "web");

	// Health probes are not logged unless they fail.
	lines.length = 0;
	const quietReq = { ...req, path: "/healthz", originalUrl: "/healthz" };
	const quietRes = { ...res, statusCode: 200 };
	requestContext(quietReq, quietRes, () => undefined);
	listeners.finish();
	assert.equal(lines.length, 0);
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
