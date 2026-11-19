// Risk signals: each defined once (key, label, explanation, how it is computed, window) and computed from a dataset
// of plain records as of a moment. Pure: the same functions serve the live evaluation (a dataset loaded around one
// person, lib/risk/engine.ts) and the backtest (a dataset loaded for a period, lib/risk/backtest.ts).
import { normalizeDevice, normalizeIp, normalizePhone } from "./lists";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// --- Dataset ---------------------------------------------------------------------------------------------------

export interface RiskEvent {
	id: string;
	type: string;
	at: number;
	actorType?: string;
	actorId?: string;
	userId?: string;
	providerId?: string;
	bookingId?: string;
	paymentId?: string;
	payoutId?: string;
	ip?: string;
	deviceId?: string;
	properties: Record<string, unknown>;
}

export interface RiskUser {
	id: string;
	createdAt: number | null;
	isProvider: boolean;
	phone?: string | null;
	/** Device ids recorded on the person's sessions. */
	sessionDevices?: string[];
	sessionIps?: string[];
}

export interface RiskBooking {
	id: string;
	userId: string;
	providerId: string | null;
	amount: number;
	hours: number;
	status: string;
	createdAt: number;
	acceptedAt?: number | null;
	startedAt?: number | null;
	completedAt?: number | null;
	cancelledAt?: number | null;
	cancelledBy?: string | null;
	address?: string | null;
}

export interface RiskPayment {
	id: string;
	bookingId: string;
	amount: number;
	status: string;
	createdAt: number;
	/** When a refund was created (cancellation, expiry or admin), if any. */
	refundAt?: number | null;
}

export interface RiskPayout {
	id: string;
	providerId: string;
	amount: number;
	createdAt: number;
	/** type|last4|country of the destination, when Stripe reported it. */
	destination?: string | null;
}

export interface RiskCharge {
	id: string;
	paymentId?: string | null;
	bookingId?: string | null;
	userId?: string | null;
	at: number;
	status: "succeeded" | "failed";
	riskLevel?: string | null;
	riskScore?: number | null;
	outcomeType?: string | null;
	/** Stripe's card fingerprint: the same card gives the same value. */
	card?: string | null;
}

/** A provider's last known position when a job started or completed, recorded at that moment. */
export interface RiskObservation {
	id: string;
	kind: "start" | "complete";
	bookingId: string;
	providerId: string;
	at: number;
	distanceKm: number;
	fixAgeMs: number;
}

export interface RiskDataset {
	users: RiskUser[];
	events: RiskEvent[];
	bookings: RiskBooking[];
	payments: RiskPayment[];
	payouts: RiskPayout[];
	charges: RiskCharge[];
	observations: RiskObservation[];
}

export const emptyDataset = (): RiskDataset => ({
	users: [],
	events: [],
	bookings: [],
	payments: [],
	payouts: [],
	charges: [],
	observations: [],
});

/** The account an event's request context (device, address) belongs to: the person who acted. */
export const eventOwner = (event: RiskEvent): string | undefined => {
	if ((event.actorType === "user" || event.actorType === "provider") && event.actorId) return event.actorId;
	if (event.type === "auth.sign_in_failed") return event.userId;
	return undefined;
};

/** Lookups built once per dataset so each signal touches only the records of the person it is about. */
export interface DatasetIndex {
	ds: RiskDataset;
	users: Map<string, RiskUser>;
	/** Events the person caused (eventOwner), oldest first. */
	eventsByOwner: Map<string, RiskEvent[]>;
	/** Events naming the person as userId or providerId, oldest first. */
	eventsBySubject: Map<string, RiskEvent[]>;
	/** Events about a customer's bookings or payments (customer from userId, else through the booking). */
	eventsByCustomer: Map<string, RiskEvent[]>;
	/** For each device and address: who used it and when. */
	deviceUse: Map<string, { owner: string; at: number }[]>;
	ipUse: Map<string, { owner: string; at: number }[]>;
	signupBlocked: RiskEvent[];
	bookings: Map<string, RiskBooking>;
	bookingsByCustomer: Map<string, RiskBooking[]>;
	bookingsByProvider: Map<string, RiskBooking[]>;
	bookingsByAddress: Map<string, RiskBooking[]>;
	paymentsByBooking: Map<string, RiskPayment[]>;
	payoutsByProvider: Map<string, RiskPayout[]>;
	payoutsByDestination: Map<string, RiskPayout[]>;
	usersByPhone: Map<string, string[]>;
	chargesByUser: Map<string, RiskCharge[]>;
	observationsByProvider: Map<string, RiskObservation[]>;
}

const push = <K, V>(map: Map<K, V[]>, key: K | null | undefined, value: V) => {
	if (key === null || key === undefined || key === "") return;
	const bucket = map.get(key);
	if (bucket) bucket.push(value);
	else map.set(key, [value]);
};

export const normalizeAddress = (address: unknown): string | null => {
	if (typeof address !== "string") return null;
	const text = address
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return text.length >= 6 ? text : null;
};

export const indexDataset = (ds: RiskDataset): DatasetIndex => {
	const byTime = <T extends { at: number }>(a: T, b: T) => a.at - b.at;
	const index: DatasetIndex = {
		ds,
		users: new Map(ds.users.map((user) => [user.id, user])),
		eventsByOwner: new Map(),
		eventsBySubject: new Map(),
		eventsByCustomer: new Map(),
		deviceUse: new Map(),
		ipUse: new Map(),
		signupBlocked: [],
		bookings: new Map(ds.bookings.map((booking) => [booking.id, booking])),
		bookingsByCustomer: new Map(),
		bookingsByProvider: new Map(),
		bookingsByAddress: new Map(),
		paymentsByBooking: new Map(),
		payoutsByProvider: new Map(),
		payoutsByDestination: new Map(),
		usersByPhone: new Map(),
		chargesByUser: new Map(),
		observationsByProvider: new Map(),
	};
	const events = [...ds.events].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	for (const event of events) {
		const owner = eventOwner(event);
		push(index.eventsByOwner, owner, event);
		push(index.eventsBySubject, event.userId, event);
		if (event.providerId && event.providerId !== event.userId) push(index.eventsBySubject, event.providerId, event);
		push(
			index.eventsByCustomer,
			event.userId ?? (event.bookingId ? index.bookings.get(event.bookingId)?.userId : undefined),
			event,
		);
		if (event.type === "signup.blocked") index.signupBlocked.push(event);
		if (owner) {
			const device = normalizeDevice(event.deviceId);
			if (device) push(index.deviceUse, device, { owner, at: event.at });
			const ip = normalizeIp(event.ip);
			if (ip) push(index.ipUse, ip, { owner, at: event.at });
		}
	}
	for (const user of ds.users) {
		for (const device of user.sessionDevices ?? []) {
			const key = normalizeDevice(device);
			if (key) push(index.deviceUse, key, { owner: user.id, at: user.createdAt ?? 0 });
		}
		push(index.usersByPhone, normalizePhone(user.phone), user.id);
	}
	for (const booking of ds.bookings) {
		push(index.bookingsByCustomer, booking.userId, booking);
		push(index.bookingsByProvider, booking.providerId, booking);
		push(index.bookingsByAddress, normalizeAddress(booking.address), booking);
	}
	for (const payment of ds.payments) push(index.paymentsByBooking, payment.bookingId, payment);
	for (const payout of [...ds.payouts].sort((a, b) => a.createdAt - b.createdAt)) {
		push(index.payoutsByProvider, payout.providerId, payout);
		push(index.payoutsByDestination, payout.destination, payout);
	}
	for (const charge of [...ds.charges].sort(byTime)) {
		const owner = charge.userId ?? (charge.bookingId ? index.bookings.get(charge.bookingId)?.userId : undefined);
		push(index.chargesByUser, owner, charge);
	}
	for (const observation of ds.observations) push(index.observationsByProvider, observation.providerId, observation);
	return index;
};

// --- Signal definitions ----------------------------------------------------------------------------------------

/** Identifying values behind a signal, under field names the demo-admin masking recognises. */
export interface EvidenceValues {
	deviceId?: string[];
	ip?: string[];
	phone?: string[];
	address?: string[];
	last4?: string[];
}

export interface EvidenceRefs {
	userIds?: string[];
	bookingIds?: string[];
	paymentIds?: string[];
	payoutIds?: string[];
	eventIds?: string[];
}

export interface SignalResult {
	/** null when the signal does not apply to this person (no data). A null never satisfies a condition. */
	value: number | null;
	/** Plain text with counts and times, never identifying values. */
	explanation: string;
	values?: EvidenceValues;
	refs?: EvidenceRefs;
}

export type SignalCategory = "linked_accounts" | "sign_in" | "velocity" | "account_age" | "collusion" | "payments";

export interface SignalDefinition {
	key: string;
	label: string;
	category: SignalCategory;
	explanation: string;
	/** Records and fields it reads. */
	computedFrom: string;
	unit: "accounts" | "count" | "hours" | "km" | "score" | "devices" | "addresses" | "cards";
	/** Look-back window in milliseconds; null for all history. */
	windowMs: number | null;
	compute: (index: DatasetIndex, userId: string, asOf: number) => SignalResult;
}

const within = (at: number, asOf: number, windowMs: number | null) =>
	at <= asOf && (windowMs === null || at > asOf - windowMs);

const uniq = <T>(items: Iterable<T>) => [...new Set(items)];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = <T>(items: T[], n = 20) => items.slice(0, n);
const hours = (ms: number) => Math.round((ms / HOUR) * 10) / 10;

/** The person's own devices or addresses in the window (from their events, plus devices on their sessions). */
const ownValues = (index: DatasetIndex, userId: string, asOf: number, windowMs: number, kind: "device" | "ip") => {
	const values = new Set<string>();
	for (const event of index.eventsByOwner.get(userId) ?? []) {
		if (!within(event.at, asOf, windowMs)) continue;
		const value = kind === "device" ? normalizeDevice(event.deviceId) : normalizeIp(event.ip);
		if (value) values.add(value);
	}
	const user = index.users.get(userId);
	for (const raw of kind === "device" ? (user?.sessionDevices ?? []) : (user?.sessionIps ?? [])) {
		const value = kind === "device" ? normalizeDevice(raw) : normalizeIp(raw);
		if (value) values.add(value);
	}
	return [...values];
};

const sharedValue = (
	index: DatasetIndex,
	userId: string,
	asOf: number,
	windowMs: number,
	kind: "device" | "ip",
): SignalResult => {
	const mine = ownValues(index, userId, asOf, windowMs, kind);
	const use = kind === "device" ? index.deviceUse : index.ipUse;
	const others = new Set<string>();
	const sharedValues: string[] = [];
	for (const value of mine) {
		const owners = uniq(
			(use.get(value) ?? [])
				.filter((u) => within(u.at, asOf, windowMs) && u.owner !== userId)
				.map((u) => u.owner),
		);
		if (owners.length) sharedValues.push(value);
		for (const owner of owners) others.add(owner);
	}
	const many = kind === "device" ? "devices" : "network addresses";
	return {
		value: mine.length ? others.size : null,
		explanation: mine.length
			? `${plural(others.size, "other account")} used ${sharedValues.length} of the ${mine.length} ${many} seen for this account.`
			: `No ${many} recorded for this account in the window.`,
		values: kind === "device" ? { deviceId: cap(sharedValues) } : { ip: cap(sharedValues) },
		refs: { userIds: cap([...others]) },
	};
};

const countEvents = (
	events: RiskEvent[] | undefined,
	asOf: number,
	windowMs: number,
	test: (event: RiskEvent) => boolean,
	what: string,
): SignalResult => {
	const matched = (events ?? []).filter((event) => within(event.at, asOf, windowMs) && test(event));
	return {
		value: matched.length,
		explanation: `${plural(matched.length, what)} in the last ${windowMs > DAY ? `${windowMs / DAY} days` : `${hours(windowMs)} h`}.`,
		refs: {
			eventIds: cap(matched.map((event) => event.id).reverse()),
			bookingIds: cap(uniq(matched.map((event) => event.bookingId).filter(Boolean) as string[])),
		},
	};
};

/** Bookings with this counterparty: the other party of each booking the person is part of. */
const pairings = (index: DatasetIndex, userId: string, asOf: number, windowMs: number) => {
	const byOther = new Map<string, RiskBooking[]>();
	const mine = [...(index.bookingsByCustomer.get(userId) ?? []), ...(index.bookingsByProvider.get(userId) ?? [])];
	for (const booking of mine) {
		if (!booking.providerId || !within(booking.createdAt, asOf, windowMs)) continue;
		if (booking.status === "cancelled" && !booking.acceptedAt) continue;
		const other = booking.userId === userId ? booking.providerId : booking.userId;
		if (other === userId) continue;
		push(byOther, other, booking);
	}
	return byOther;
};

/** Completed in under half the booked hours. */
export const FAST_COMPLETION_RATIO = 0.5;
const isFastCompletion = (booking: RiskBooking) =>
	booking.status === "completed" &&
	!!booking.startedAt &&
	!!booking.completedAt &&
	booking.hours > 0 &&
	booking.completedAt - booking.startedAt < booking.hours * HOUR * FAST_COMPLETION_RATIO;

/** A booking at or above this amount (dollars) is "large" for the account-age signal. */
export const LARGE_BOOKING_AMOUNT = 300;

/** Position fixes older than this when the job started or completed are not used. */
export const MAX_FIX_AGE_MS = 30 * MINUTE;

const ELEVATED_RISK_LEVELS = new Set(["elevated", "highest"]);
const ELEVATED_OUTCOMES = new Set(["blocked", "manual_review"]);

export const SIGNALS: readonly SignalDefinition[] = [
	{
		key: "shared_device_accounts",
		label: "Accounts sharing a device",
		category: "linked_accounts",
		explanation: "Other accounts that used any device this account used.",
		computedFrom:
			"Request context device id (X-Device-Id) on events the person caused, and device ids on their sessions.",
		unit: "accounts",
		windowMs: 90 * DAY,
		compute: (index, userId, asOf) => sharedValue(index, userId, asOf, 90 * DAY, "device"),
	},
	{
		key: "shared_ip_accounts",
		label: "Accounts sharing a network address",
		category: "linked_accounts",
		explanation:
			"Other accounts seen from any IP address this account used. Hotels and mobile networks share addresses, so weigh it lightly.",
		computedFrom: "Request context IP on events the person caused, and the last IP on their sessions.",
		unit: "accounts",
		windowMs: 30 * DAY,
		compute: (index, userId, asOf) => sharedValue(index, userId, asOf, 30 * DAY, "ip"),
	},
	{
		key: "shared_phone_accounts",
		label: "Accounts sharing a phone number",
		category: "linked_accounts",
		explanation: "Other accounts with the same phone number (compared on the last nine digits).",
		computedFrom: "users.phone.",
		unit: "accounts",
		windowMs: null,
		compute: (index, userId) => {
			const user = index.users.get(userId);
			const key = normalizePhone(user?.phone);
			if (!key) return { value: null, explanation: "No phone number on this account." };
			const others = (index.usersByPhone.get(key) ?? []).filter((id) => id !== userId);
			return {
				value: others.length,
				explanation: `${plural(others.length, "other account")} with the same phone number.`,
				values: others.length && user?.phone ? { phone: [user.phone] } : undefined,
				refs: { userIds: cap(others) },
			};
		},
	},
	{
		key: "shared_payout_destination_accounts",
		label: "Providers sharing payout bank details",
		category: "linked_accounts",
		explanation:
			"Other providers whose payouts went to a destination with the same type, last four digits and country. Stripe does not give the full account number, so a match is strong but not certain.",
		computedFrom: "payouts.destinationDetails (type, last4, country).",
		unit: "accounts",
		windowMs: null,
		compute: (index, userId, asOf) => {
			const mine = (index.payoutsByProvider.get(userId) ?? []).filter(
				(p) => p.createdAt <= asOf && p.destination,
			);
			if (!mine.length) return { value: null, explanation: "No payout destination recorded." };
			const destinations = uniq(mine.map((p) => p.destination as string));
			const others = new Set<string>();
			const payoutIds: string[] = [];
			for (const destination of destinations) {
				for (const payout of index.payoutsByDestination.get(destination) ?? []) {
					if (payout.providerId === userId || payout.createdAt > asOf) continue;
					others.add(payout.providerId);
					payoutIds.push(payout.id);
				}
			}
			return {
				value: others.size,
				explanation: `${plural(others.size, "other provider")} paid out to the same bank details (${plural(destinations.length, "destination")} on this account).`,
				values: { last4: cap(destinations.map((d) => d.split("|")[1] ?? "")) },
				refs: { userIds: cap([...others]), payoutIds: cap(payoutIds) },
			};
		},
	},
	{
		key: "shared_booking_address_accounts",
		label: "Customers booking the same address",
		category: "linked_accounts",
		explanation: "Other customer accounts that booked jobs at an address this customer booked.",
		computedFrom: "bookings.address (case, spacing and punctuation ignored).",
		unit: "accounts",
		windowMs: 180 * DAY,
		compute: (index, userId, asOf) => {
			const mine = (index.bookingsByCustomer.get(userId) ?? []).filter((b) =>
				within(b.createdAt, asOf, 180 * DAY),
			);
			const addresses = uniq(mine.map((b) => normalizeAddress(b.address)).filter(Boolean) as string[]);
			if (!addresses.length) return { value: null, explanation: "No bookings as a customer in the window." };
			const others = new Set<string>();
			const shared: string[] = [];
			for (const address of addresses) {
				const otherCustomers = (index.bookingsByAddress.get(address) ?? [])
					.filter((b) => b.userId !== userId && within(b.createdAt, asOf, 180 * DAY))
					.map((b) => b.userId);
				if (otherCustomers.length)
					shared.push(mine.find((b) => normalizeAddress(b.address) === address)!.address!);
				for (const id of otherCustomers) others.add(id);
			}
			return {
				value: others.size,
				explanation: `${plural(others.size, "other customer")} booked at ${plural(addresses.length, "address", "addresses")} this customer used.`,
				values: { address: cap(shared, 5) },
				refs: { userIds: cap([...others]) },
			};
		},
	},
	{
		key: "sign_in_devices_24h",
		label: "Devices signing in, 24 h",
		category: "sign_in",
		explanation: "Distinct devices that signed in to this account in the last 24 hours.",
		computedFrom: "auth.sign_in_succeeded events (request context device id).",
		unit: "devices",
		windowMs: DAY,
		compute: (index, userId, asOf) => {
			const signIns = (index.eventsBySubject.get(userId) ?? []).filter(
				(e) => e.type === "auth.sign_in_succeeded" && within(e.at, asOf, DAY),
			);
			const devices = uniq(signIns.map((e) => normalizeDevice(e.deviceId)).filter(Boolean) as string[]);
			return {
				value: devices.length,
				explanation: `${plural(devices.length, "device")} across ${plural(signIns.length, "sign-in")} in 24 h.`,
				values: { deviceId: cap(devices) },
				refs: { eventIds: cap(signIns.map((e) => e.id).reverse()) },
			};
		},
	},
	{
		key: "sign_in_ips_1h",
		label: "Addresses signing in, 1 h",
		category: "sign_in",
		explanation:
			"Distinct IP addresses that tried to sign in to this account (succeeded or failed) in the last hour.",
		computedFrom: "auth.sign_in_succeeded and auth.sign_in_failed events (request context IP).",
		unit: "addresses",
		windowMs: HOUR,
		compute: (index, userId, asOf) => {
			const attempts = (index.eventsBySubject.get(userId) ?? []).filter(
				(e) =>
					(e.type === "auth.sign_in_succeeded" || e.type === "auth.sign_in_failed") &&
					within(e.at, asOf, HOUR),
			);
			const ips = uniq(attempts.map((e) => normalizeIp(e.ip)).filter(Boolean) as string[]);
			return {
				value: ips.length,
				explanation: `${plural(ips.length, "address", "addresses")} across ${plural(attempts.length, "sign-in attempt")} in the last hour.`,
				values: { ip: cap(ips) },
				refs: { eventIds: cap(attempts.map((e) => e.id).reverse()) },
			};
		},
	},
	{
		key: "sign_in_failures_1h",
		label: "Failed sign-ins, 1 h",
		category: "velocity",
		explanation: "Failed sign-in attempts on this account in the last hour.",
		computedFrom: "auth.sign_in_failed events with this userId.",
		unit: "count",
		windowMs: HOUR,
		compute: (index, userId, asOf) =>
			countEvents(
				index.eventsBySubject.get(userId),
				asOf,
				HOUR,
				(e) => e.type === "auth.sign_in_failed",
				"failed sign-in",
			),
	},
	{
		key: "bookings_created_24h",
		label: "Bookings created, 24 h",
		category: "velocity",
		explanation: "Bookings this customer created in the last 24 hours.",
		computedFrom: "booking.created events.",
		unit: "count",
		windowMs: DAY,
		compute: (index, userId, asOf) =>
			countEvents(
				index.eventsBySubject.get(userId),
				asOf,
				DAY,
				(e) => e.type === "booking.created" && e.userId === userId,
				"booking",
			),
	},
	{
		key: "payments_succeeded_24h",
		label: "Payments, 24 h",
		category: "velocity",
		explanation: "Card payments this customer made in the last 24 hours.",
		computedFrom: "payment.succeeded events.",
		unit: "count",
		windowMs: DAY,
		compute: (index, userId, asOf) =>
			countEvents(index.eventsBySubject.get(userId), asOf, DAY, (e) => e.type === "payment.succeeded", "payment"),
	},
	{
		key: "payment_failures_24h",
		label: "Failed payments, 24 h",
		category: "velocity",
		explanation: "Card payments that failed for this customer's bookings in the last 24 hours.",
		computedFrom: "payment.failed events (customer found through the booking).",
		unit: "count",
		windowMs: DAY,
		compute: (index, userId, asOf) => {
			return countEvents(
				index.eventsByCustomer.get(userId),
				asOf,
				DAY,
				(e) => e.type === "payment.failed",
				"failed payment",
			);
		},
	},
	{
		key: "cancellations_24h",
		label: "Cancellations made, 24 h",
		category: "velocity",
		explanation: "Bookings this person cancelled in the last 24 hours.",
		computedFrom: "booking.cancelled events the person caused.",
		unit: "count",
		windowMs: DAY,
		compute: (index, userId, asOf) =>
			countEvents(
				index.eventsByOwner.get(userId),
				asOf,
				DAY,
				(e) => e.type === "booking.cancelled",
				"cancellation",
			),
	},
	{
		key: "refunds_7d",
		label: "Refunds, 7 days",
		category: "velocity",
		explanation: "Refunds created on this customer's payments in the last 7 days.",
		computedFrom: "refund.created events (customer found through the booking).",
		unit: "count",
		windowMs: 7 * DAY,
		compute: (index, userId, asOf) => {
			return countEvents(
				index.eventsByCustomer.get(userId),
				asOf,
				7 * DAY,
				(e) => e.type === "refund.created",
				"refund",
			);
		},
	},
	{
		key: "payout_requests_24h",
		label: "Payout requests, 24 h",
		category: "velocity",
		explanation: "Payouts this provider requested in the last 24 hours.",
		computedFrom: "payout.requested events, or payouts when the events are missing.",
		unit: "count",
		windowMs: DAY,
		compute: (index, userId, asOf) => {
			const payouts = (index.payoutsByProvider.get(userId) ?? []).filter((p) => within(p.createdAt, asOf, DAY));
			const events = (index.eventsBySubject.get(userId) ?? []).filter(
				(e) => e.type === "payout.requested" && within(e.at, asOf, DAY),
			);
			const count = Math.max(payouts.length, events.length);
			return {
				value: count,
				explanation: `${plural(count, "payout request")} in the last 24 h.`,
				refs: { payoutIds: cap(payouts.map((p) => p.id)) },
			};
		},
	},
	{
		key: "account_age_at_first_large_booking_hours",
		label: "Account age at first large booking",
		category: "account_age",
		explanation: `Hours between sign-up and the customer's first booking of $${LARGE_BOOKING_AMOUNT} or more. Empty when there is none.`,
		computedFrom: "users.createdAt and bookings (rate × hours).",
		unit: "hours",
		windowMs: null,
		compute: (index, userId, asOf) => {
			const user = index.users.get(userId);
			const first = (index.bookingsByCustomer.get(userId) ?? [])
				.filter((b) => b.createdAt <= asOf && b.amount >= LARGE_BOOKING_AMOUNT)
				.sort((a, b) => a.createdAt - b.createdAt)[0];
			if (!first || !user?.createdAt) return { value: null, explanation: "No large booking yet." };
			const age = hours(first.createdAt - user.createdAt);
			return {
				value: age,
				explanation: `First booking of $${first.amount} made ${age} h after sign-up.`,
				refs: { bookingIds: [first.id] },
			};
		},
	},
	{
		key: "account_age_at_first_payout_hours",
		label: "Account age at first payout",
		category: "account_age",
		explanation: "Hours between the provider's sign-up and their first payout request. Empty when there is none.",
		computedFrom: "users.createdAt and payouts.createdAt.",
		unit: "hours",
		windowMs: null,
		compute: (index, userId, asOf) => {
			const user = index.users.get(userId);
			const first = (index.payoutsByProvider.get(userId) ?? []).find((p) => p.createdAt <= asOf);
			if (!first || !user?.createdAt) return { value: null, explanation: "No payout yet." };
			const age = hours(first.createdAt - user.createdAt);
			return {
				value: age,
				explanation: `First payout of $${first.amount} requested ${age} h after sign-up.`,
				refs: { payoutIds: [first.id] },
			};
		},
	},
	{
		key: "repeat_pair_bookings_30d",
		label: "Same customer and provider, 30 days",
		category: "collusion",
		explanation:
			"The most bookings this person had with any single counterparty (customer with provider) in the last 30 days.",
		computedFrom: "bookings with a provider (cancelled before acceptance left out).",
		unit: "count",
		windowMs: 30 * DAY,
		compute: (index, userId, asOf) => {
			let best: { other: string; bookings: RiskBooking[] } | null = null;
			for (const [other, bookings] of pairings(index, userId, asOf, 30 * DAY)) {
				if (!best || bookings.length > best.bookings.length) best = { other, bookings };
			}
			if (!best) return { value: 0, explanation: "No bookings with a counterparty in 30 days." };
			return {
				value: best.bookings.length,
				explanation: `${plural(best.bookings.length, "booking")} with the same counterparty in 30 days.`,
				refs: { userIds: [best.other], bookingIds: cap(best.bookings.map((b) => b.id)) },
			};
		},
	},
	{
		key: "repeat_pair_fast_completions_30d",
		label: "Fast completions with the same counterparty",
		category: "collusion",
		explanation: `The most jobs with one counterparty completed in under ${FAST_COMPLETION_RATIO * 100}% of the booked hours, in the last 30 days.`,
		computedFrom: "bookings.startedAt, completedAt and hours.",
		unit: "count",
		windowMs: 30 * DAY,
		compute: (index, userId, asOf) => {
			let best: { other: string; bookings: RiskBooking[] } | null = null;
			for (const [other, bookings] of pairings(index, userId, asOf, 30 * DAY)) {
				const fast = bookings.filter((b) => isFastCompletion(b) && (b.completedAt ?? 0) <= asOf);
				if (fast.length && (!best || fast.length > best.bookings.length)) best = { other, bookings: fast };
			}
			if (!best) return { value: 0, explanation: "No fast completions with a repeat counterparty." };
			return {
				value: best.bookings.length,
				explanation: `${plural(best.bookings.length, "job")} with the same counterparty completed in under half the booked time.`,
				refs: { userIds: [best.other], bookingIds: cap(best.bookings.map((b) => b.id)) },
			};
		},
	},
	{
		key: "fast_completions_30d",
		label: "Fast completions, 30 days",
		category: "collusion",
		explanation: `Jobs this provider completed in under ${FAST_COMPLETION_RATIO * 100}% of the booked hours in the last 30 days.`,
		computedFrom: "bookings.startedAt, completedAt and hours.",
		unit: "count",
		windowMs: 30 * DAY,
		compute: (index, userId, asOf) => {
			const fast = (index.bookingsByProvider.get(userId) ?? []).filter(
				(b) => isFastCompletion(b) && within(b.completedAt!, asOf, 30 * DAY),
			);
			return {
				value: index.users.get(userId)?.isProvider === false && !fast.length ? null : fast.length,
				explanation: `${plural(fast.length, "job")} completed in under half the booked hours.`,
				refs: { bookingIds: cap(fast.map((b) => b.id)) },
			};
		},
	},
	{
		key: "start_far_from_booking_km",
		label: "Distance from the job when starting or completing",
		category: "collusion",
		explanation:
			"The furthest the provider's last known position was from the booking's location when a job was started or completed in the last 30 days (fixes older than 30 minutes are not used).",
		computedFrom:
			"Provider position (users.currentLocation and locationUpdatedAt) recorded at booking.started and booking.completed, against bookings.latitude/longitude.",
		unit: "km",
		windowMs: 30 * DAY,
		compute: (index, userId, asOf) => {
			const usable = (index.observationsByProvider.get(userId) ?? []).filter(
				(o) => within(o.at, asOf, 30 * DAY) && o.fixAgeMs <= MAX_FIX_AGE_MS,
			);
			if (!usable.length) return { value: null, explanation: "No usable position at a start or completion." };
			const worst = usable.reduce((a, b) => (b.distanceKm > a.distanceKm ? b : a));
			return {
				value: Math.round(worst.distanceKm * 10) / 10,
				explanation: `At a job ${worst.kind === "start" ? "start" : "completion"} the provider was ${Math.round(worst.distanceKm * 10) / 10} km from the booking (${plural(usable.length, "position")} checked).`,
				refs: { bookingIds: cap(usable.filter((o) => o.distanceKm >= 1).map((o) => o.bookingId)) },
			};
		},
	},
	{
		key: "cancellations_after_acceptance_30d",
		label: "Cancellations after acceptance, 30 days",
		category: "collusion",
		explanation: "Bookings this person cancelled after a provider had accepted them, in the last 30 days.",
		computedFrom: "bookings.cancelledBy, cancelledAt and acceptedAt.",
		unit: "count",
		windowMs: 30 * DAY,
		compute: (index, userId, asOf) => {
			const mine = [
				...(index.bookingsByCustomer.get(userId) ?? []),
				...(index.bookingsByProvider.get(userId) ?? []),
			];
			const cancelled = uniq(mine).filter(
				(b) =>
					b.cancelledBy === userId &&
					!!b.cancelledAt &&
					!!b.acceptedAt &&
					b.acceptedAt <= b.cancelledAt &&
					within(b.cancelledAt, asOf, 30 * DAY),
			);
			return {
				value: cancelled.length,
				explanation: `${plural(cancelled.length, "booking")} cancelled after acceptance.`,
				refs: { bookingIds: cap(cancelled.map((b) => b.id)) },
			};
		},
	},
	{
		key: "refunds_after_acceptance_30d",
		label: "Refunds after acceptance, 30 days",
		category: "payments",
		explanation:
			"This customer's bookings that a provider had accepted and that were then refunded, in the last 30 days.",
		computedFrom: "bookings.acceptedAt and payments.refundCreated.",
		unit: "count",
		windowMs: 30 * DAY,
		compute: (index, userId, asOf) => {
			const refunded = (index.bookingsByCustomer.get(userId) ?? []).filter(
				(b) =>
					!!b.acceptedAt &&
					(index.paymentsByBooking.get(b.id) ?? []).some(
						(p) => !!p.refundAt && p.refundAt >= (b.acceptedAt ?? 0) && within(p.refundAt, asOf, 30 * DAY),
					),
			);
			return {
				value: refunded.length,
				explanation: `${plural(refunded.length, "accepted booking")} refunded.`,
				refs: { bookingIds: cap(refunded.map((b) => b.id)) },
			};
		},
	},
	{
		key: "distinct_cards_7d",
		label: "Cards tried, 7 days",
		category: "payments",
		explanation:
			"Different cards used in this customer's payment attempts (succeeded or failed) in the last 7 days.",
		computedFrom: "Stripe charge card fingerprints recorded from the payment webhooks.",
		unit: "cards",
		windowMs: 7 * DAY,
		compute: (index, userId, asOf) => {
			const charges = (index.chargesByUser.get(userId) ?? []).filter((c) => within(c.at, asOf, 7 * DAY));
			if (!charges.length) return { value: null, explanation: "No card attempts recorded in 7 days." };
			const cards = uniq(charges.map((c) => c.card).filter(Boolean) as string[]);
			return {
				value: cards.length,
				explanation: `${plural(cards.length, "card")} across ${plural(charges.length, "payment attempt")}.`,
				refs: { paymentIds: cap(uniq(charges.map((c) => c.paymentId).filter(Boolean) as string[])) },
			};
		},
	},
	{
		key: "signup_blocked_attempts_7d",
		label: "Blocked sign-ups from the same device or address",
		category: "sign_in",
		explanation:
			"Sign-ups the email policy refused (disposable or undeliverable address) from a device or IP address this account used, in the last 7 days.",
		computedFrom: "signup.blocked events matched on request context device id and IP.",
		unit: "count",
		windowMs: 7 * DAY,
		compute: (index, userId, asOf) => {
			const devices = new Set(ownValues(index, userId, asOf, 30 * DAY, "device"));
			const ips = new Set(ownValues(index, userId, asOf, 30 * DAY, "ip"));
			const matched = index.signupBlocked.filter(
				(e) =>
					within(e.at, asOf, 7 * DAY) &&
					((normalizeDevice(e.deviceId) && devices.has(normalizeDevice(e.deviceId)!)) ||
						(normalizeIp(e.ip) && ips.has(normalizeIp(e.ip)!))),
			);
			return {
				value: matched.length,
				explanation: `${plural(matched.length, "refused sign-up")} from this account's devices or addresses.`,
				refs: { eventIds: cap(matched.map((e) => e.id)) },
			};
		},
	},
	{
		key: "stripe_elevated_risk_charges_30d",
		label: "Charges Stripe rated risky, 30 days",
		category: "payments",
		explanation:
			"This customer's charges that Stripe Radar rated elevated or highest risk, or blocked or sent to review, in the last 30 days.",
		computedFrom: "Stripe charge outcome (risk_level, type) recorded from the payment webhooks.",
		unit: "count",
		windowMs: 30 * DAY,
		compute: (index, userId, asOf) => {
			const charges = (index.chargesByUser.get(userId) ?? []).filter((c) => within(c.at, asOf, 30 * DAY));
			if (!charges.length) return { value: null, explanation: "No Stripe assessments recorded in 30 days." };
			const risky = charges.filter(
				(c) => ELEVATED_RISK_LEVELS.has(c.riskLevel ?? "") || ELEVATED_OUTCOMES.has(c.outcomeType ?? ""),
			);
			return {
				value: risky.length,
				explanation: `${plural(risky.length, "charge")} of ${charges.length} rated risky by Stripe.`,
				refs: { paymentIds: cap(uniq(risky.map((c) => c.paymentId).filter(Boolean) as string[])) },
			};
		},
	},
	{
		key: "stripe_max_risk_score_30d",
		label: "Highest Stripe risk score, 30 days",
		category: "payments",
		explanation:
			"The highest Radar risk score (0-99) on this customer's charges in the last 30 days. Stripe sends a score only on accounts with Radar for Fraud Teams; otherwise empty.",
		computedFrom: "Stripe charge outcome risk_score.",
		unit: "score",
		windowMs: 30 * DAY,
		compute: (index, userId, asOf) => {
			const scored = (index.chargesByUser.get(userId) ?? []).filter(
				(c) => within(c.at, asOf, 30 * DAY) && typeof c.riskScore === "number",
			);
			if (!scored.length) return { value: null, explanation: "No Stripe risk score recorded." };
			const top = scored.reduce((a, b) => ((b.riskScore ?? 0) > (a.riskScore ?? 0) ? b : a));
			return {
				value: top.riskScore ?? null,
				explanation: `Highest score ${top.riskScore} across ${plural(scored.length, "charge")}.`,
				refs: { paymentIds: top.paymentId ? [top.paymentId] : [] },
			};
		},
	},
];

export type SignalKey = (typeof SIGNALS)[number]["key"];

export const SIGNAL_BY_KEY: ReadonlyMap<string, SignalDefinition> = new Map(SIGNALS.map((s) => [s.key, s]));

export const isSignalKey = (key: unknown): key is string => typeof key === "string" && SIGNAL_BY_KEY.has(key);

/** Computes the named signals (all when omitted) for one person as of a moment. */
export const computeSignals = (
	index: DatasetIndex,
	userId: string,
	asOf: number,
	keys: readonly string[] = SIGNALS.map((s) => s.key),
): Record<string, SignalResult> => {
	const out: Record<string, SignalResult> = {};
	for (const key of keys) {
		const signal = SIGNAL_BY_KEY.get(key);
		if (signal) out[key] = signal.compute(index, userId, asOf);
	}
	return out;
};

/** The public description of each signal (no compute function). */
export const signalCatalogue = () =>
	SIGNALS.map(({ key, label, category, explanation, computedFrom, unit, windowMs }) => ({
		key,
		label,
		category,
		explanation,
		computedFrom,
		unit,
		windowHours: windowMs === null ? null : windowMs / HOUR,
	}));

/** Great-circle distance in km. */
export const distanceKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
	const rad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = rad(lat2 - lat1);
	const dLon = rad(lon2 - lon1);
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** A usable position: finite, inside the globe and not the app's 0,0 placeholder. */
export const isUsablePosition = (lat: unknown, lon: unknown): lat is number =>
	typeof lat === "number" &&
	typeof lon === "number" &&
	Number.isFinite(lat) &&
	Number.isFinite(lon) &&
	Math.abs(lat) <= 90 &&
	Math.abs(lon) <= 180 &&
	!(lat === 0 && lon === 0);
