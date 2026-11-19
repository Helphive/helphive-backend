// A dataset in which every risk signal has something to find (tests/riskSignals.test.ts, tests/riskLists.test.ts).
import { emptyDataset, type RiskDataset, type RiskEvent } from "../lib/risk/signals";

export const H = 60 * 60 * 1000;
const D = 24 * H;
export const NOW = Date.parse("2026-11-19T12:00:00Z");
const id = (n: number) => n.toString(16).padStart(24, "0");

export const CUST = id(1);
const CUST2 = id(2);
export const PROV = id(3);
const PROV2 = id(4);
export const CUST3 = id(5);
const CUST4 = id(6);
const CUST5 = id(7);

let seq = 100;
const ev = (type: string, at: number, extra: Partial<RiskEvent> = {}): RiskEvent => ({
	id: id(seq++),
	type,
	at,
	properties: {},
	...extra,
});

/** One dataset in which every signal has something to find for CUST or PROV. */
export const fixture = (): RiskDataset => {
	const ds = emptyDataset();
	ds.users = [
		{ id: CUST, createdAt: NOW - 30 * H, isProvider: false, phone: "07911 123456", sessionDevices: ["dev-a"] },
		{ id: CUST2, createdAt: NOW - 90 * D, isProvider: false, phone: "+44 7911 123456" },
		{ id: PROV, createdAt: NOW - 2 * D, isProvider: true, phone: "0161 555 0000" },
		{ id: PROV2, createdAt: NOW - 200 * D, isProvider: true },
		{ id: CUST3, createdAt: NOW - 100 * D, isProvider: false },
		{ id: CUST4, createdAt: NOW - 100 * D, isProvider: false },
		{ id: CUST5, createdAt: NOW - 100 * D, isProvider: false },
	];
	const user = (who: string) => ({ actorType: "user", actorId: who, userId: who });
	// Four devices and four addresses sign in to CUST within the hour.
	for (let i = 0; i < 4; i++) {
		ds.events.push(
			ev("auth.sign_in_succeeded", NOW - 10 * 60_000 * (i + 1), {
				...user(CUST),
				deviceId: `dev-${"abcd"[i]}`,
				ip: `203.0.113.${i + 1}`,
			}),
		);
	}
	// Other accounts on CUST's device dev-a (PROV2, CUST2) and network 203.0.113.1 (PROV2 only).
	ds.events.push(
		ev("auth.sign_in_succeeded", NOW - 5 * D, {
			actorType: "provider",
			actorId: PROV2,
			providerId: PROV2,
			deviceId: "DEV-A",
			ip: "203.0.113.1",
		}),
	);
	ds.events.push(ev("booking.created", NOW - 6 * D, { ...user(CUST2), deviceId: "dev-a" }));
	for (let i = 0; i < 10; i++)
		ds.events.push(ev("auth.sign_in_failed", NOW - 30 * 60_000, { actorType: "anonymous", userId: CUST }));
	for (let i = 0; i < 10; i++) ds.events.push(ev("booking.created", NOW - 2 * H, user(CUST)));
	for (let i = 0; i < 8; i++)
		ds.events.push(ev("payment.succeeded", NOW - 3 * H, { actorType: "system", userId: CUST }));
	for (let i = 0; i < 3; i++)
		ds.events.push(ev("payment.failed", NOW - 4 * H, { actorType: "system", bookingId: id(901) }));
	for (let i = 0; i < 5; i++)
		ds.events.push(ev("booking.cancelled", NOW - 5 * H, { ...user(CUST), bookingId: id(906) }));
	for (let i = 0; i < 3; i++)
		ds.events.push(ev("refund.created", NOW - 2 * D, { actorType: "system", bookingId: id(901) }));
	// Three refused sign-ups from CUST's first network address, one outside the 7-day window.
	for (let i = 0; i < 3; i++)
		ds.events.push(ev("signup.blocked", NOW - 1 * D, { actorType: "anonymous", ip: "203.0.113.1" }));
	ds.events.push(ev("signup.blocked", NOW - 9 * D, { actorType: "anonymous", ip: "203.0.113.1" }));

	// Bookings: five between CUST and PROV, $400 each, completed in 30 minutes of 4 booked hours.
	for (let i = 1; i <= 5; i++) {
		ds.bookings.push({
			id: id(900 + i),
			userId: CUST,
			providerId: PROV,
			amount: 400,
			hours: 4,
			status: "completed",
			createdAt: NOW - 20 * H + i,
			acceptedAt: NOW - 19 * H,
			startedAt: NOW - 10 * H,
			completedAt: NOW - 10 * H + 30 * 60_000,
			address: i === 1 ? "Premier Inn, 7 Portland Street" : "Hotel " + i,
		});
	}
	// Cancelled by CUST after PROV accepted, three times.
	for (let i = 6; i <= 8; i++) {
		ds.bookings.push({
			id: id(900 + i),
			userId: CUST,
			providerId: PROV,
			amount: 80,
			hours: 4,
			status: "cancelled",
			createdAt: NOW - 3 * D,
			acceptedAt: NOW - 3 * D + H,
			cancelledAt: NOW - 3 * D + 2 * H,
			cancelledBy: CUST,
			address: "Hotel x",
		});
	}
	// Three other customers booked CUST's first address.
	for (const [n, who] of [
		[920, CUST3],
		[921, CUST4],
		[922, CUST5],
	] as const) {
		ds.bookings.push({
			id: id(n),
			userId: who,
			providerId: null,
			amount: 50,
			hours: 2,
			status: "pending",
			createdAt: NOW - 10 * D,
			address: "premier inn 7 PORTLAND street",
		});
	}
	ds.payments = [
		{
			id: id(801),
			bookingId: id(901),
			amount: 400,
			status: "completed",
			createdAt: NOW - 20 * H,
			refundAt: NOW - 2 * H,
		},
		{
			id: id(806),
			bookingId: id(906),
			amount: 80,
			status: "completed",
			createdAt: NOW - 3 * D,
			refundAt: NOW - 3 * D + 3 * H,
		},
	];
	// PROV: three payouts in 24 h to the same bank details as PROV2.
	for (let i = 0; i < 3; i++) {
		ds.payouts.push({
			id: id(700 + i),
			providerId: PROV,
			amount: 50,
			createdAt: NOW - (i + 1) * H,
			destination: "bank_account|6789|GB",
		});
	}
	ds.payouts.push({
		id: id(710),
		providerId: PROV2,
		amount: 90,
		createdAt: NOW - 50 * D,
		destination: "bank_account|6789|GB",
	});
	ds.charges = [
		{
			id: id(601),
			userId: CUST,
			at: NOW - 3 * H,
			status: "succeeded",
			card: "fp1",
			riskLevel: "normal",
			riskScore: 20,
			outcomeType: "authorized",
		},
		{
			id: id(602),
			userId: CUST,
			at: NOW - 3 * H,
			status: "failed",
			card: "fp2",
			riskLevel: "elevated",
			riskScore: 80,
			outcomeType: "issuer_declined",
		},
		{
			id: id(603),
			bookingId: id(901),
			at: NOW - 3 * H,
			status: "failed",
			card: "fp3",
			riskLevel: "normal",
			outcomeType: "blocked",
		},
	];
	ds.observations = [
		{
			id: id(501),
			kind: "start",
			bookingId: id(901),
			providerId: PROV,
			at: NOW - 10 * H,
			distanceKm: 7.24,
			fixAgeMs: 5 * 60_000,
		},
		{
			id: id(502),
			kind: "complete",
			bookingId: id(902),
			providerId: PROV,
			at: NOW - 9 * H,
			distanceKm: 50,
			fixAgeMs: 2 * H,
		},
	];
	return ds;
};
