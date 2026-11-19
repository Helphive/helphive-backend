// Run with: npx ts-node tests/providerWebsocketAuth.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	AUTH_TIMEOUT_MS,
	AvailabilityUpdate,
	ProviderSocketDeps,
	WS_CLOSE,
	attachProviderSocket,
	parseClientMessage,
} from "../controllers/user-controllers/provider-websocket-auth";
import { RATE_LIMITS } from "../middleware/rateLimitKeys";

class FakeSocket extends EventEmitter {
	sent: any[] = [];
	closedWith: { code?: number; reason?: string } | null = null;
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close(code?: number, reason?: string) {
		if (this.closedWith) return;
		this.closedWith = { code, reason };
		this.emit("close");
	}
	receive(message: unknown) {
		this.emit("message", Buffer.from(typeof message === "string" ? message : JSON.stringify(message)), false);
	}
}

// Read through a function so an earlier assertion on closedWith does not narrow its type.
const closeCode = (ws: FakeSocket) => ws.closedWith?.code;

const VALID_TOKEN = "valid-token";
const PROVIDER_EMAIL = "provider@example.com";

const setup = (overrides: Partial<ProviderSocketDeps> = {}) => {
	const ws = new FakeSocket();
	const saved: { email: string; update: AvailabilityUpdate }[] = [];
	const offline: string[] = [];
	const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
	let sessionActive = true;
	const deps: ProviderSocketDeps = {
		authenticate: async (token) =>
			token === VALID_TOKEN ? { ok: true, email: PROVIDER_EMAIL, sessionId: "s1" } : { ok: false },
		stillAuthorized: async () => sessionActive,
		saveAvailability: async (email, update) => {
			saved.push({ email, update });
		},
		onAuthenticated: () => undefined,
		onAuthenticatedClose: (email) => offline.push(email),
		setTimer: (fn, ms) => {
			const timer = { fn, ms, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle) => {
			if (handle) (handle as { cleared: boolean }).cleared = true;
		},
		...overrides,
	};
	const handle = attachProviderSocket(ws, deps);
	const fireTimers = () => timers.filter((t) => !t.cleared).forEach((t) => t.fn());
	return { ws, saved, offline, timers, handle, fireTimers, endSession: () => (sessionActive = false) };
};

const availability = {
	isProviderAvailable: true,
	currentLocation: { latitude: 51.5, longitude: -0.12 },
	selectedJobs: [1, 3],
};

test("a socket with no auth message is closed with 4401 after 10 seconds", async () => {
	const { ws, timers, fireTimers, offline } = setup();
	assert.equal(timers[0].ms, AUTH_TIMEOUT_MS);
	assert.equal(AUTH_TIMEOUT_MS, 10_000);
	fireTimers();
	assert.equal(closeCode(ws), WS_CLOSE.UNAUTHORIZED);
	assert.equal(offline.length, 0, "an unauthenticated socket never marks anyone offline");
});

test("messages before authentication are ignored, including the old email-based availability", async () => {
	const { ws, saved, handle } = setup();
	ws.receive(availability);
	ws.receive({ ...availability, email: "victim@example.com" });
	ws.receive("not json");
	await handle.settled();
	assert.equal(saved.length, 0);
	assert.equal(ws.sent.length, 0);
	assert.equal(ws.closedWith, null, "still waiting for auth within the deadline");
});

test("an invalid token closes the socket with 4401", async () => {
	const { ws, handle, saved } = setup();
	ws.receive({ type: "auth", token: "forged" });
	await handle.settled();
	assert.equal(closeCode(ws), WS_CLOSE.UNAUTHORIZED);
	ws.receive(availability);
	await handle.settled();
	assert.equal(saved.length, 0);
});

test("a malformed auth message is ignored and the deadline still applies", async () => {
	const { ws, handle, fireTimers } = setup();
	ws.receive({ type: "auth", token: 42 });
	ws.receive({ type: "auth" });
	await handle.settled();
	assert.equal(ws.closedWith, null);
	fireTimers();
	assert.equal(closeCode(ws), WS_CLOSE.UNAUTHORIZED);
});

test("after auth the socket acts only for the token's user, never an email the client sends", async () => {
	const { ws, handle, saved, timers, offline } = setup();
	ws.receive({ type: "auth", token: VALID_TOKEN });
	await handle.settled();
	assert.deepEqual(ws.sent[0], { type: "auth_ok" });
	assert.equal(timers[0].cleared, true, "the auth deadline is cancelled");
	ws.receive({ ...availability, email: "victim@example.com" });
	await handle.settled();
	assert.equal(saved.length, 1);
	assert.equal(saved[0].email, PROVIDER_EMAIL);
	assert.deepEqual(saved[0].update, availability);
	assert.equal(ws.sent[1].type, "availability_updated");
	ws.close();
	assert.deepEqual(offline, [PROVIDER_EMAIL]);
});

test("a second auth message cannot switch the socket to another user", async () => {
	const { ws, handle, saved } = setup({
		authenticate: async (token) => ({
			ok: true,
			email: token === VALID_TOKEN ? PROVIDER_EMAIL : "other@x.com",
			sessionId: "s",
		}),
	});
	ws.receive({ type: "auth", token: VALID_TOKEN });
	ws.receive({ type: "auth", token: "someone-else" });
	ws.receive(availability);
	await handle.settled();
	assert.equal(handle.email, PROVIDER_EMAIL);
	assert.equal(saved[0].email, PROVIDER_EMAIL);
});

test("an ended session (logout, password reset, lost approval) closes the socket with 4401", async () => {
	const { ws, handle, saved, endSession } = setup();
	ws.receive({ type: "auth", token: VALID_TOKEN });
	await handle.settled();
	endSession();
	ws.receive(availability);
	await handle.settled();
	assert.equal(saved.length, 0);
	assert.equal(closeCode(ws), WS_CLOSE.UNAUTHORIZED);
});

test("invalid availability after auth gets an error and is not saved", async () => {
	const { ws, handle, saved } = setup();
	ws.receive({ type: "auth", token: VALID_TOKEN });
	ws.receive({ isProviderAvailable: "yes" });
	ws.receive({ isProviderAvailable: true, selectedJobs: [9] });
	await handle.settled();
	assert.equal(saved.length, 0);
	assert.deepEqual(
		ws.sent.slice(1).map((m) => m.type),
		["error", "error"],
	);
	assert.equal(ws.closedWith, null);
});

test("too many messages close the socket with 4429", async () => {
	const { ws, handle } = setup();
	ws.receive({ type: "auth", token: VALID_TOKEN });
	for (let i = 0; i < RATE_LIMITS.wsMessagesPerSocket.limit + 5; i++) ws.receive(availability);
	await handle.settled();
	assert.equal(closeCode(ws), WS_CLOSE.RATE_LIMITED);
});

test("an authentication error from the database closes with 4401 rather than hanging", async () => {
	const { ws, handle } = setup({
		authenticate: async () => {
			throw new Error("db down");
		},
		log: () => undefined,
	});
	ws.receive({ type: "auth", token: VALID_TOKEN });
	await handle.settled();
	assert.equal(closeCode(ws), WS_CLOSE.UNAUTHORIZED);
});

test("parseClientMessage validates shapes", () => {
	assert.deepEqual(parseClientMessage(JSON.stringify({ type: "auth", token: "t" })), { kind: "auth", token: "t" });
	assert.equal(parseClientMessage("[]").kind, "invalid");
	assert.equal(parseClientMessage("x".repeat(5000)).kind, "invalid");
	// The app sends nulls before it has a location fix; that keeps the stored location.
	assert.deepEqual(
		parseClientMessage(
			JSON.stringify({ isProviderAvailable: false, currentLocation: { latitude: null, longitude: null } }),
		),
		{ kind: "availability", update: { isProviderAvailable: false } },
	);
	assert.deepEqual(
		parseClientMessage(
			JSON.stringify({ isProviderAvailable: true, currentLocation: { latitude: 200, longitude: 0 } }),
		),
		{ kind: "availability", update: { isProviderAvailable: true } },
	);
	assert.deepEqual(parseClientMessage(JSON.stringify({ isProviderAvailable: true, selectedJobs: [2, 2] })), {
		kind: "availability",
		update: { isProviderAvailable: true, selectedJobs: [2] },
	});
	assert.equal(
		parseClientMessage(JSON.stringify({ isProviderAvailable: true, selectedJobs: [{ $gt: 0 }] })).kind,
		"invalid",
	);
});
