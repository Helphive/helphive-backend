// Run with: npx ts-node tests/operationsMasking.test.ts
// The demo admin's masking applied to the response shapes of the operations console, built with the controllers' own
// mappers where they are pure, plus realistic detail fixtures. Nothing personal may survive; amounts, statuses,
// dates, service types, counts, ids and the operator-facing explanations must.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

delete process.env.DATABASE_URI;
mongoose.set("bufferCommands", false);
process.env.STRIPE_SECRET_KEY = "sk_test_unit_only";

/* eslint-disable @typescript-eslint/no-require-imports */
const { MASK, maskForDemo } = require("../lib/demoMask") as typeof import("../lib/demoMask");
const { DEMO_ACCOUNT_EMAILS } = require("../config/demoAccounts");
const { userListItem, payoutListItem } = require("../controllers/admin/users.controller");
const { bookingCore } = require("../controllers/admin/bookings.controller");
const { adminPayment } = require("../controllers/admin/payments.controller");
const { personSummary, publicNote, publicEvent } = require("../controllers/admin/operations.shared");
const { buildAttention, coarseLocation } = require("../lib/operations");
/* eslint-enable @typescript-eslint/no-require-imports */

const mask = (body: unknown) => maskForDemo(body, { exemptEmails: DEMO_ACCOUNT_EMAILS }) as any;
const oid = () => new mongoose.Types.ObjectId();

const customerDoc = {
	_id: oid(),
	firstName: "Amira",
	lastName: "Haddad",
	email: "amira.haddad@gmail.com",
	phone: "+44 7700 900461",
	roles: { User: true, Provider: false },
	isEmailVerified: true,
	suspended: true,
	suspendedAt: new Date("2026-11-18T10:00:00Z"),
	street: "14 Wellington Road",
	// The real case: a street address typed into the city field.
	city: "14 wellington road, flat 3",
	state: "greater manchester",
	country: "gb",
	createdAt: new Date("2026-02-01T09:00:00Z"),
	lastActiveAt: new Date("2026-11-17T20:00:00Z"),
};
const providerDoc = {
	_id: oid(),
	firstName: "Tomasz",
	lastName: "Kowalczyk",
	email: "t.kowalczyk@outlook.com",
	phone: "07911 123456",
	roles: { User: false, Provider: true },
	providerStatus: "approved",
	isProviderAvailable: true,
	selectedJobTypes: [{ id: 2, name: "Room Attendant" }],
	city: "salford",
	state: "lancs",
	country: "gb",
	createdAt: new Date("2026-03-01T09:00:00Z"),
};
const bookingDoc = {
	_id: new mongoose.Types.ObjectId("6740a1b2c3d4e5f601234567"),
	status: "cancelled",
	userId: customerDoc._id,
	providerId: providerDoc._id,
	service: { id: 2, name: "Room Attendant" },
	rate: 20,
	hours: 4,
	startDate: new Date("2026-11-20T08:00:00Z"),
	address: "Premier Inn, 7 Portland Street, Manchester M1 3BE",
	latitude: 53.479876,
	longitude: -2.236521,
	createdAt: new Date("2026-11-18T09:00:00Z"),
	cancelledAt: new Date("2026-11-18T12:00:00Z"),
	cancelledBy: customerDoc._id,
	cancellationReason: "Hotel closed the floor for Amira's event",
};
const paymentDoc = {
	_id: oid(),
	bookingId: bookingDoc._id,
	amount: 80,
	status: "completed",
	date: new Date("2026-11-18T09:01:00Z"),
	paidAt: new Date("2026-11-18T09:01:30Z"),
	paymentIntentId: "pi_3QxYzAbCdEfGh12",
	clientSecret: "pi_3QxYzAbCdEfGh12_secret_abcdef",
	paymentMethod: "pm_1QxYzAbCdEf",
	refundId: "re_3QxYzAbCdEfGh99",
	refundStatus: "succeeded",
	refundAmount: 50,
	refundCreated: new Date("2026-11-18T12:05:00Z"),
	destinationDetails: { type: "card" },
	refunds: [
		{
			idempotencyKey: "dlg-7f3a9c2e-1",
			amount: 30,
			status: "succeeded",
			refundId: "re_3QxYzAbCdEfGh98",
			requestedAt: new Date("2026-11-18T11:00:00Z"),
			createdAt: new Date("2026-11-18T11:00:02Z"),
			source: "admin",
		},
		{
			idempotencyKey: "dlg-7f3a9c2e-2",
			amount: 20,
			status: "succeeded",
			refundId: "re_3QxYzAbCdEfGh99",
			requestedAt: new Date("2026-11-18T12:04:58Z"),
			createdAt: new Date("2026-11-18T12:05:00Z"),
			source: "admin",
		},
	],
};

const noLeak = (out: unknown, secrets: string[]) => {
	const text = JSON.stringify(out);
	for (const secret of secrets) assert.equal(text.includes(secret), false, `"${secret}" leaked`);
};

const PERSONAL = [
	"amira.haddad",
	"gmail.com",
	"Haddad",
	"900461",
	"Wellington",
	"wellington",
	"greater manchester",
	"Kowalczyk",
	"outlook.com",
	"07911",
	"salford",
	"lancs",
	"Portland Street",
	"M1 3BE",
	"53.479876",
	"-2.236521",
	"pi_3QxYzAbCdEfGh12",
	"re_3QxYzAbCdEfGh9",
	"pm_1QxYzAbCdEf",
	"dlg-7f3a9c2e",
	"Amira's event",
];

test("users list rows: names, contact details and free-text places masked; country, statuses and dates kept", () => {
	const out = mask({
		items: [userListItem(customerDoc), userListItem(providerDoc)],
		page: 1,
		pageSize: 25,
		total: 2,
	});
	noLeak(out, PERSONAL);
	const [c, p] = out.items;
	assert.equal(c.firstName, "Amira");
	assert.equal(c.lastName, "H.");
	assert.equal(c.email, "a•••@•••.com");
	assert.equal(c.phone, "•••61");
	assert.equal(c.city, MASK, "street address typed into city is masked");
	assert.equal(c.state, MASK);
	assert.equal(c.country, "gb");
	assert.equal(c.suspended, true);
	assert.equal(c.lastActiveAt, "2026-11-17T20:00:00.000Z");
	assert.deepEqual(p.services, ["Room Attendant"]);
	assert.equal(p.providerStatus, "approved");
	assert.equal(out.total, 2);
});

test("user detail: account state with reason and admin, sessions, devices, provider Stripe state, applications", () => {
	const out = mask({
		user: { ...userListItem(customerDoc), street: customerDoc.street, hasPhoto: true },
		account: {
			emailVerified: true,
			suspended: true,
			suspendedAt: "2026-11-18T10:00:00.000Z",
			suspendedReason: "Chargebacks on three cards, see note from Amira's bank",
			suspendedBy: "6740a1b2c3d4e5f60aaaaaaa",
		},
		sessions: [
			{
				sessionId: "6740a1b2c3d4e5f60bbbbbbb",
				lastIp: "81.2.69.160",
				userAgent: "HelpHive/1.4 (iPhone; iOS 18.1)",
				platform: "ios",
				appVersion: "1.4.2+57",
				deviceId: "c7f2a9e0-5b1d-4f6e-9a3c-2d8e7f6a5b4c",
			},
		],
		devices: [{ deviceId: "c7f2a9e0-5b1d-4f6e-9a3c-2d8e7f6a5b4c", platform: "ios", events: 41 }],
		provider: {
			services: [{ id: 2, name: "Room Attendant" }],
			approximateLocation: coarseLocation(53.479876, -2.236521),
			stripe: { status: "ready", accountId: "acct_1QxYzAbCdEfGh", payoutsEnabled: true },
			availableBalance: 152,
			recentPayouts: [
				payoutListItem({
					_id: oid(),
					userId: providerDoc._id,
					amount: 120,
					currency: "usd",
					status: "failed",
					payoutId: "po_1QxYzAbCdEfGh",
					destinationAccount: "acct_1QxYzAbCdEfGh",
					destinationDetails: { type: "bank_account", last4: "6789", country: "GB" },
					createdAt: new Date("2026-11-10T10:00:00Z"),
				}),
			],
		},
		applications: [
			{ status: "approved", city: "14 wellington road", state: "gm", country: "gb", rejectReason: null },
		],
	});
	noLeak(out, [
		...PERSONAL,
		"81.2.69.160",
		"c7f2a9e0",
		"acct_1QxYzAbCdEfGh",
		"po_1QxYzAbCdEfGh",
		"6789",
		"Chargebacks",
	]);
	assert.equal(out.user.street, MASK);
	assert.equal(out.account.suspendedReason, MASK);
	assert.equal(out.account.suspended, true);
	assert.equal(out.sessions[0].sessionId, MASK);
	assert.equal(out.sessions[0].platform, "ios");
	assert.equal(out.sessions[0].appVersion, "1.4.2+57");
	assert.deepEqual(out.provider.approximateLocation, { latitude: 53.5, longitude: -2.2, precisionKm: 1.1 });
	assert.equal(out.provider.stripe.status, "ready");
	assert.equal(out.provider.recentPayouts[0].status, "failed");
	assert.equal(out.provider.recentPayouts[0].amount, 120);
	assert.equal(out.provider.recentPayouts[0].destination.country, "GB");
	assert.equal(out.applications[0].city, MASK);
	assert.equal(out.applications[0].country, "gb");
});

test("booking list row and detail: nested customer and provider, address and coordinates, payments, notes", () => {
	const people = new Map([
		[String(customerDoc._id), personSummary(customerDoc)],
		[String(providerDoc._id), personSummary(providerDoc)],
	]);
	const note = publicNote({
		_id: oid(),
		targetType: "booking",
		targetId: bookingDoc._id,
		body: "Called Amira on 07700 900461, she wants a refund to amira.haddad@gmail.com's card",
		author: { id: oid(), email: "ops.lead@helphive.himaiz.com" },
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	const out = mask({
		booking: bookingCore(bookingDoc),
		customer: people.get(String(customerDoc._id)),
		provider: people.get(String(providerDoc._id)),
		payments: [adminPayment(paymentDoc)],
		notifications: [{ title: "Booking cancelled", type: "booking_cancelled", recipient: "customer" }],
		timeline: [
			{ source: "booking", step: "cancelled", at: bookingDoc.cancelledAt },
			{
				source: "event",
				step: "booking.cancelled",
				event: publicEvent({
					_id: oid(),
					type: "booking.cancelled",
					at: bookingDoc.cancelledAt,
					actor: { type: "admin", id: "6740a1b2c3d4e5f60aaaaaaa" },
					bookingId: bookingDoc._id,
					properties: { by: "admin", onBehalfOf: "customer", reason: "Customer asked by phone" },
					context: { ip: "81.2.69.160" },
				}),
			},
		],
		notes: [note],
		audit: [
			{
				action: "bookings.cancelled",
				actor: { type: "admin", email: "ops.lead@helphive.himaiz.com" },
				reason: "Customer asked by phone, Amira Haddad",
				summary: { before: { status: "pending" }, after: { status: "cancelled" } },
				ip: "81.2.69.160",
			},
		],
	});
	noLeak(out, [...PERSONAL, "81.2.69.160", "ops.lead", "asked by phone", "Called Amira"]);
	assert.equal(out.booking.reference, "HH-01234567");
	assert.equal(out.booking.address, MASK);
	assert.equal(out.booking.latitude, 53.5);
	assert.equal(out.booking.longitude, -2.2);
	assert.equal(out.booking.cancellationReason, MASK);
	assert.equal(out.booking.amount, 80);
	assert.deepEqual(out.booking.service, { id: 2, name: "Room Attendant" });
	assert.equal(out.customer.name, "Amira H.");
	assert.equal(out.provider.name, "Tomasz K.");
	assert.equal(out.provider.email, "t•••@•••.com");
	const payment = out.payments[0];
	assert.equal(payment.paymentIntentId, MASK);
	assert.equal(payment.refund.latestRefundId, MASK);
	assert.equal(payment.refund.totalRefunded, 50);
	assert.equal(payment.remainingRefundable, 30);
	assert.equal(payment.platformFee, 4);
	assert.equal("clientSecret" in payment, false, "never sent to admins at all");
	assert.deepEqual(
		payment.refunds.map((r: any) => [r.refundId, r.amount, r.status]),
		[
			[MASK, 30, "succeeded"],
			[MASK, 20, "succeeded"],
		],
	);
	assert.equal(out.timeline[1].event.properties.reason, MASK);
	assert.equal(out.timeline[1].event.properties.onBehalfOf, "customer");
	assert.equal("context" in out.timeline[1].event, false, "events on detail pages carry no request context");
	assert.equal(out.notes[0].body, MASK);
	assert.equal(out.notes[0].author.email, "o•••@•••.com");
	assert.equal(out.audit[0].reason, MASK);
	assert.equal(out.audit[0].action, "bookings.cancelled");
});

test("payment detail: Stripe ids in webhook events, earnings and transfers are masked", () => {
	const out = mask({
		payment: adminPayment(paymentDoc),
		earning: { amount: 76, status: "completed", transferId: "tr_1QxYzAbCdEfGh" },
		webhookEvents: [
			{
				eventId: "evt_1QxYzAbCdEfGh",
				type: "refund.updated",
				objectId: "re_3QxYzAbCdEfGh99",
				outcome: "processed",
				note: "refund for amira.haddad@gmail.com",
				error: null,
			},
		],
		refund: { refundId: "re_3QxYzAbCdEfGh99", amount: 20, status: "succeeded" },
	});
	noLeak(out, [...PERSONAL, "tr_1QxYzAbCdEfGh", "evt_1QxYzAbCdEfGh"]);
	assert.equal(out.webhookEvents[0].type, "refund.updated");
	assert.equal(out.webhookEvents[0].outcome, "processed");
	assert.equal(out.earning.amount, 76);
	assert.equal(out.refund.amount, 20);
});

test("overview attention items and the live view keep the operator's explanation and coarse positions only", () => {
	const now = new Date("2026-11-19T12:00:00Z");
	const attention = buildAttention(
		{
			unassignedPaid: [{ _id: bookingDoc._id, startDate: new Date(now.getTime() + 40 * 60 * 1000) }],
			inProgress: [],
			acceptedNotStarted: [],
			startRequests: [],
			pendingEarnings: [],
			failedPayouts: [],
			failedRefunds: [],
			pendingApplications: [],
		},
		now,
	);
	const out = mask({
		attention,
		recentActivity: [
			publicEvent({
				_id: oid(),
				type: "auth.sign_in_failed",
				at: now,
				actor: { type: "anonymous" },
				userId: customerDoc._id,
				properties: { reason: "suspended", emailHash: "9f2c1a" },
				context: { ip: "81.2.69.160", deviceId: "c7f2a9e0" },
			}),
		],
		live: {
			providers: [
				{
					_id: String(providerDoc._id),
					firstName: "Tomasz",
					lastName: "Kowalczyk",
					services: [{ id: 2, name: "Room Attendant" }],
					approximateLocation: coarseLocation(53.483959, -2.244644),
				},
			],
			bookings: [
				{
					reference: "HH-01234567",
					approximateLocation: coarseLocation(bookingDoc.latitude, bookingDoc.longitude),
					customer: personSummary(customerDoc),
				},
			],
		},
	});
	noLeak(out, [...PERSONAL, "81.2.69.160", "9f2c1a", "53.48", "-2.24"]);
	assert.match(out.attention.items[0].explanation, /starts in 40 min/);
	assert.equal(out.attention.items[0].link.id, String(bookingDoc._id));
	assert.equal(out.attention.counts.unassigned_near_start, 1);
	assert.deepEqual(out.live.providers[0].approximateLocation, { latitude: 53.5, longitude: -2.2, precisionKm: 1.1 });
	assert.equal(out.live.providers[0].lastName, "K.");
	assert.deepEqual(out.live.providers[0].services, [{ id: 2, name: "Room Attendant" }]);
	assert.equal(out.live.bookings[0].customer.phone, "•••61");
});

test("global search results: names, emails and echoed query text masked; types, references and links kept", () => {
	const out = mask({
		query: "amira.haddad@gmail.com",
		results: {
			users: [
				{ type: "user", ...personSummary(customerDoc), link: { type: "user", id: String(customerDoc._id) } },
			],
			bookings: [
				{
					type: "booking",
					reference: "HH-01234567",
					customerName: "Amira Haddad",
					displayStatus: "cancelled",
					link: { type: "booking", id: String(bookingDoc._id) },
				},
			],
			payments: [{ type: "payment", bookingReference: "HH-01234567", amount: 80, status: "completed" }],
			applications: [
				{ type: "application", name: "Tomasz Kowalczyk", email: "t.kowalczyk@outlook.com", status: "pending" },
			],
		},
	});
	noLeak(out, PERSONAL);
	assert.equal(out.query, "a•••@•••.com");
	assert.equal(out.results.users[0].name, "Amira H.");
	assert.equal(out.results.bookings[0].customerName, "Amira H.");
	assert.equal(out.results.bookings[0].reference, "HH-01234567");
	assert.equal(out.results.applications[0].name, "Tomasz K.");
	assert.equal(out.results.payments[0].amount, 80);
});

test("the shared demo customer's records stay readable in the new shapes too", () => {
	const demo = { ...customerDoc, email: "user@helphive.himaiz.com", lastName: "User", city: "london" };
	const out = mask({ items: [userListItem(demo)] });
	assert.equal(out.items[0].lastName, "User");
	assert.equal(out.items[0].city, "london");
});
