// Run with: npx ts-node tests/demoAdmin.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MASK, maskEmailForDemo, maskForDemo, maskFullName, maskPhone } from "../lib/demoMask";
import { DEMO_ACCOUNT_EMAILS, DEMO_ADMIN_READ_ONLY, demoAdminEmails, isDemoAdminEmail } from "../config/demoAccounts";
import { ROLE_PERMISSIONS, effectiveRole, isDemoAdmin, hasPermission } from "../config/adminPermissions";
import { setLogSink } from "../lib/logger";

mongoose.set("bufferCommands", false);
process.env.ADMIN_ACCESS_TOKEN_SECRET = "test-admin-secret";
setLogSink(() => undefined);
/* eslint-disable @typescript-eslint/no-require-imports */
const { demoMayRequest, demoReadOnly, demoResponseMask } =
	require("../middleware/demoAdmin") as typeof import("../middleware/demoAdmin");
const { signAdminAccessToken } =
	require("../controllers/admin/adminSessions") as typeof import("../controllers/admin/adminSessions");
/* eslint-enable @typescript-eslint/no-require-imports */

const mask = (body: unknown) => maskForDemo(body, { exemptEmails: DEMO_ACCOUNT_EMAILS }) as any;
const DEMO_EMAIL = "demo.admin@helphive.himaiz.com";

test("role resolution: an email in DEMO_ADMIN_EMAILS is the demo role whatever its stored role says", () => {
	assert.equal(isDemoAdminEmail(DEMO_EMAIL), true);
	assert.equal(isDemoAdminEmail(" Demo.Admin@HelpHive.himaiz.com "), true);
	assert.equal(
		effectiveRole({ email: DEMO_EMAIL, role: "superAdmin", roles: { admin: true, superAdmin: true } }),
		"demo",
	);
	assert.equal(effectiveRole({ email: "ops@example.com", role: "demo" }), "demo", "stored role demo");
	assert.equal(effectiveRole({ email: "ops@example.com", roles: { admin: true, superAdmin: true } }), "superAdmin");
	assert.equal(isDemoAdmin({ email: DEMO_EMAIL }), true);
	assert.deepEqual(
		[...demoAdminEmails("a@x.com, B@Y.com ,")],
		["a@x.com", "b@y.com"],
		"env list replaces the default",
	);
	assert.deepEqual([...demoAdminEmails("")], [DEMO_EMAIL]);
	assert.deepEqual(
		[...ROLE_PERMISSIONS.demo].sort(),
		[...ROLE_PERMISSIONS.analyst].sort(),
		"reads what an analyst reads",
	);
	assert.equal(hasPermission({ email: DEMO_EMAIL, role: "superAdmin" }, "admins.manage"), false);
	assert.equal(hasPermission({ email: DEMO_EMAIL }, "applications.review"), false);
});

test("field helpers: email, phone, names", () => {
	assert.equal(maskEmailForDemo("jane.doe@example.co.uk"), "j•••@•••.uk");
	assert.equal(maskEmailForDemo("a@b.com"), "a•••@•••.com");
	assert.equal(maskPhone("+44 7700 900123"), "•••23");
	assert.equal(maskPhone("x"), MASK);
	assert.equal(maskFullName("Jane Mary Doe"), "Jane D.");
	assert.equal(maskFullName("Cher"), "Cher");
});

test("masking: every personal field type, nested objects and arrays; amounts, statuses, dates and unknown fields kept", () => {
	const body = {
		message: "OK",
		items: [
			{
				_id: "64b7f0c2a1b2c3d4e5f60718",
				firstName: "Jane",
				lastName: "Doe",
				email: "jane.doe@example.com",
				phone: "+44 7700 900123",
				street: "1 high street",
				city: "london",
				country: "uk",
				currentLocation: { latitude: 51.50735, longitude: -0.12776 },
				stripeConnectedAccountId: "acct_1Nabcdef",
				availableBalance: 420.5,
				status: "approved",
				createdAt: "2026-03-01T09:00:00.000Z",
				service: { id: 2, name: "Room Attendant" },
				profile: "64b7f0c2a1b2c3d4e5f60718/profile.jpg",
				id: "https://storage.googleapis.com/helphive/abc/id.pdf?X-Goog-Signature=1",
				dbs: "abc/dbs.pdf",
				rejectReason: "ID photo is blurry, Jane",
				decisions: [{ status: "rejected", byEmail: "ops@helphive.himaiz.com", reason: "Blurry" }],
				sessions: [
					{ id: "s1", ip: "203.0.113.7", userAgent: "Mozilla/5.0", deviceId: "dev-1", lastIp: "2001:db8::1" },
				],
				payment: {
					amount: 80,
					paymentIntentId: "pi_3Nabcdef",
					clientSecret: "pi_3N_secret_x",
					refundId: "re_1abcdefg",
				},
				payout: {
					payoutId: "po_1abcdefg",
					destinationDetails: { type: "bank_account", last4: "6789", country: "GB" },
				},
				notification: { title: "Booking accepted", message: "Pat accepted your booking at 1 high street" },
				hours: 4,
				unknownField: "kept as is",
				note: "",
			},
		],
		page: 1,
		total: 1,
	};
	const out = mask(body);
	const item = out.items[0];
	assert.equal(out.message, "OK", "the API's own top-level message is kept");
	assert.equal(out.page, 1);
	assert.equal(out.total, 1);
	assert.equal(item._id, "64b7f0c2a1b2c3d4e5f60718");
	assert.equal(item.firstName, "Jane");
	assert.equal(item.lastName, "D.");
	assert.equal(item.email, "j•••@•••.com");
	assert.equal(item.phone, "•••23");
	assert.equal(item.street, MASK);
	assert.equal(item.city, MASK, "free-text place fields are masked whole");
	assert.equal(item.country, "uk");
	assert.deepEqual(item.currentLocation, { latitude: 51.5, longitude: -0.1 });
	assert.equal(item.stripeConnectedAccountId, MASK);
	assert.equal(item.availableBalance, 420.5);
	assert.equal(item.status, "approved");
	assert.equal(item.createdAt, "2026-03-01T09:00:00.000Z");
	assert.deepEqual(item.service, { id: 2, name: "Room Attendant" }, "service name is not a person's name");
	assert.equal(item.profile, null, "photo path removed");
	assert.equal(item.id, null, "signed document URL removed");
	assert.equal(item.dbs, null);
	assert.equal(item.rejectReason, MASK);
	assert.deepEqual(item.decisions, [{ status: "rejected", byEmail: "o•••@•••.com", reason: MASK }]);
	assert.deepEqual(item.sessions, [{ id: "s1", ip: MASK, userAgent: MASK, deviceId: MASK, lastIp: MASK }]);
	assert.deepEqual(item.payment, { amount: 80, paymentIntentId: MASK, clientSecret: MASK, refundId: MASK });
	assert.deepEqual(item.payout, {
		payoutId: MASK,
		destinationDetails: { type: "bank_account", last4: MASK, country: "GB" },
	});
	assert.deepEqual(item.notification, { title: "Booking accepted", message: MASK });
	assert.equal(item.hours, 4);
	assert.equal(item.unknownField, "kept as is");
	assert.equal(item.note, "", "empty text stays empty");
});

test("masking: value patterns are caught under any field name (emails, Stripe ids, IPs, links)", () => {
	const out = mask({
		meta: {
			contact: "write to jane@example.com",
			ref: "ch_3Nabcdefg",
			seenFrom: "198.51.100.4",
			link: "https://x.example/a.png",
			path: "abc/resume.docx",
		},
	});
	assert.deepEqual(out.meta, { contact: "write to j•••@•••.com", ref: MASK, seenFrom: MASK, link: null, path: null });
});

test("masking: audit entries and tokens", () => {
	const out = mask({
		entry: {
			action: "applications.rejected",
			actor: { type: "admin", id: "64b7f0c2a1b2c3d4e5f60718", email: "ops@helphive.himaiz.com" },
			summary: { before: { status: "pending" }, after: { status: "rejected", rejectReason: "Blurry" } },
			reason: "Blurry",
			ip: "203.0.113.7",
			userAgent: "Console",
			requestId: "req-1",
			metadata: { accessToken: "eyJ...", emailHash: "abc" },
		},
	});
	assert.equal(out.entry.actor.email, "o•••@•••.com");
	assert.deepEqual(out.entry.summary, {
		before: { status: "pending" },
		after: { status: "rejected", rejectReason: MASK },
	});
	assert.equal(out.entry.reason, MASK);
	assert.equal(out.entry.ip, MASK);
	assert.equal(out.entry.requestId, "req-1");
	assert.deepEqual(out.entry.metadata, { accessToken: MASK, emailHash: MASK });
});

test("masking: the shared demo customer and provider stay readable, except their documents", () => {
	const out = mask([
		{
			email: "provider@helphive.himaiz.com",
			lastName: "Provider",
			phone: "+1 555 0100",
			street: "1 demo road",
			profile: "x/profile.png",
		},
		{ email: "someone@real.com", lastName: "Real", phone: "+1 555 0199" },
		{
			booking: {
				address: "2 real street",
				userId: { email: "user@helphive.himaiz.com", lastName: "User", phone: "+1 555 0101" },
			},
		},
	]);
	assert.deepEqual(out[0], {
		email: "provider@helphive.himaiz.com",
		lastName: "Provider",
		phone: "+1 555 0100",
		street: "1 demo road",
		profile: null,
	});
	assert.deepEqual(out[1], { email: "s•••@•••.com", lastName: "R.", phone: "•••99" });
	assert.equal(out[2].booking.address, MASK, "the booking itself is not the demo account's record");
	assert.deepEqual(out[2].booking.userId, {
		email: "user@helphive.himaiz.com",
		lastName: "User",
		phone: "+1 555 0101",
	});
});

test("masking keeps the shape res.json would send (ObjectIds and Dates serialised, strings and nulls pass)", () => {
	const oid = new mongoose.Types.ObjectId();
	assert.deepEqual(mask({ _id: oid, at: new Date("2026-01-01T00:00:00Z"), none: null }), {
		_id: String(oid),
		at: "2026-01-01T00:00:00.000Z",
		none: null,
	});
	assert.equal(
		mask("Provider account request and user status updated successfully"),
		"Provider account request and user status updated successfully",
	);
	assert.equal(mask(undefined), undefined);
});

test("read-only: which requests a demo admin may make", () => {
	for (const [method, path] of [
		["GET", "/audit"],
		["HEAD", "/account"],
		["OPTIONS", "/admins"],
		["POST", "/login"],
		["POST", "/login/mfa"],
		["POST", "/refresh"],
		["POST", "/logout"],
		["post", "/logout/"],
	]) {
		assert.equal(demoMayRequest(method, path), true, `${method} ${path}`);
	}
	for (const [method, path] of [
		["POST", "/update-provider-account-request-status"],
		["POST", "/logout-all"],
		["DELETE", "/sessions/64b7f0c2a1b2c3d4e5f60718"],
		["POST", "/change-password"],
		["POST", "/mfa/enroll"],
		["POST", "/mfa/disable"],
		["POST", "/admins"],
		["PATCH", "/admins/64b7f0c2a1b2c3d4e5f60718/role"],
		["PUT", "/anything-added-later"],
		["POST", "/signup"],
	]) {
		assert.equal(demoMayRequest(method, path), false, `${method} ${path}`);
	}
});

const fakeRes = () => {
	const res: any = { statusCode: 200, body: undefined };
	res.status = (code: number) => ((res.statusCode = code), res);
	res.json = (body: unknown) => ((res.body = body), res);
	return res;
};

test("read-only middleware: a demo admin's write gets 403 demo_read_only; other admins and reads pass", async () => {
	const demo = { _id: new mongoose.Types.ObjectId(), email: DEMO_EMAIL, roles: { admin: true, superAdmin: false } };
	const ops = {
		_id: new mongoose.Types.ObjectId(),
		email: "ops@example.com",
		role: "operations",
		roles: { admin: true },
	};
	const call = async (method: string, path: string, admin: unknown) => {
		const req: any = {
			method,
			path,
			baseUrl: "/admin",
			headers: {},
			adminAuth: Promise.resolve({ ok: true, admin }),
		};
		const res = fakeRes();
		let passed = false;
		await demoReadOnly(req, res, () => (passed = true));
		return { passed, res };
	};
	const refused = await call("POST", "/update-provider-account-request-status", demo);
	assert.equal(refused.passed, false);
	assert.equal(refused.res.statusCode, 403);
	assert.deepEqual(refused.res.body, {
		message: "This action is turned off for the demo admin.",
		code: "demo_read_only",
	});
	assert.deepEqual(DEMO_ADMIN_READ_ONLY, refused.res.body);
	assert.equal((await call("POST", "/update-provider-account-request-status", ops)).passed, true);
	assert.equal((await call("GET", "/provider-account-requests", demo)).passed, true);
	assert.equal((await call("POST", "/logout", demo)).passed, true);
	const unauthenticated: any = {
		method: "POST",
		path: "/admins",
		baseUrl: "/admin",
		headers: {},
		adminAuth: Promise.resolve({ ok: false, status: 401, message: "x" }),
	};
	let passed = false;
	await demoReadOnly(unauthenticated, fakeRes(), () => (passed = true));
	assert.equal(passed, true, "left to the route's own authentication");
});

test("response masking applies to demo admins' successful responses only", () => {
	const send = (admin: unknown, status: number, body: unknown) => {
		const res = fakeRes();
		res.statusCode = status;
		const req: any = { admin };
		demoResponseMask(req, res, () => undefined);
		res.json(body);
		return res.body;
	};
	const body = { email: "jane@example.com" };
	assert.deepEqual(send({ email: DEMO_EMAIL }, 200, body), { email: "j•••@•••.com" });
	assert.deepEqual(send({ email: "ops@example.com", role: "operations" }, 200, body), body);
	assert.deepEqual(send({ email: DEMO_EMAIL }, 403, { message: "x", email: "a@b.com" }), {
		message: "x",
		email: "a@b.com",
	});
	assert.deepEqual(send(undefined, 200, body), body, "sign-in replies (no req.admin yet) are not masked");
});

test("demo tokens carry a demo claim so per-address limits apply without a database read", () => {
	const demoToken = signAdminAccessToken({
		_id: new mongoose.Types.ObjectId(),
		email: DEMO_EMAIL,
		roles: { admin: true, superAdmin: false },
		tokenVersion: 0,
	} as any);
	assert.equal((jwt.decode(demoToken.token) as any).demo, true);
	const opsToken = signAdminAccessToken({
		_id: new mongoose.Types.ObjectId(),
		email: "ops@example.com",
		roles: { admin: true, superAdmin: false },
		tokenVersion: 0,
	} as any);
	assert.equal("demo" in (jwt.decode(opsToken.token) as any), false);
});
