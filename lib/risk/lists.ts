// Block and allow lists: normalising what a person presents (email, device, address, phone) and matching it against
// list entries. Pure; the cached entries and the request gate live in lib/risk/gate.ts.
import net from "net";

export const LIST_TYPES = ["block", "allow"] as const;
export type ListType = (typeof LIST_TYPES)[number];

export const LIST_KINDS = ["email", "email_domain", "device", "ip", "ip_range", "phone"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export const LIST_KIND_LABELS: Record<ListKind, string> = {
	email: "Email address",
	email_domain: "Email domain",
	device: "Device id",
	ip: "IP address",
	ip_range: "IP range (CIDR)",
	phone: "Phone number",
};

/** Mailbox providers that ignore dots in the local part. */
const DOTLESS_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * One canonical form per mailbox: lower case, the "+tag" removed, and for Gmail the dots removed and googlemail.com
 * read as gmail.com. "Jane.Doe+promo@GoogleMail.com" and "janedoe@gmail.com" are the same person.
 */
export const normalizeEmail = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	const at = email.lastIndexOf("@");
	if (at < 1 || at === email.length - 1) return null;
	let local = email.slice(0, at);
	let domain = email.slice(at + 1).replace(/\.+$/, "");
	const plus = local.indexOf("+");
	if (plus > 0) local = local.slice(0, plus);
	if (DOTLESS_DOMAINS.has(domain)) {
		local = local.replace(/\./g, "");
		domain = "gmail.com";
	}
	if (!local || !domain.includes(".")) return null;
	return `${local}@${domain}`;
};

export const normalizeDomain = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const domain = value.trim().toLowerCase().replace(/^@/, "").replace(/\.+$/, "");
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
	return domain === "googlemail.com" ? "gmail.com" : domain;
};

/** The domain and each parent ("a.b.example.com" -> itself, "b.example.com", "example.com"). */
export const domainAndParents = (domain: string): string[] => {
	const parts = domain.split(".");
	const out: string[] = [];
	for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
	return out;
};

export const normalizeDevice = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const device = value.trim().toLowerCase();
	return device.length >= 4 && device.length <= 128 ? device : null;
};

/**
 * Phones are stored as people typed them ("07911 123456", "+44 7911 123456"). The key is the last nine digits,
 * which survives a country code or a national 0 prefix; numbers with fewer than seven digits have no key.
 */
export const normalizePhone = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const digits = value.replace(/\D/g, "");
	if (digits.length < 7) return null;
	return digits.slice(-9);
};

// --- IP addresses and ranges ----------------------------------------------------------------------------------

export interface ParsedIp {
	version: 4 | 6;
	value: bigint;
}

const parseV4 = (text: string): bigint | null => {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	let value = 0n;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const n = Number(part);
		if (n > 255) return null;
		value = (value << 8n) + BigInt(n);
	}
	return value;
};

const parseV6 = (text: string): bigint | null => {
	if (!net.isIPv6(text)) return null;
	let address = text;
	// An embedded IPv4 tail ("::ffff:1.2.3.4") becomes two hextets.
	const v4Tail = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (v4Tail) {
		const v4 = parseV4(v4Tail[1]);
		if (v4 === null) return null;
		address = `${address.slice(0, -v4Tail[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
	}
	const [head, tail] = address.split("::");
	const headParts = head ? head.split(":") : [];
	const tailParts = tail !== undefined && tail ? tail.split(":") : [];
	const missing = 8 - headParts.length - tailParts.length;
	if (tail === undefined && missing !== 0) return null;
	const all = [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts];
	if (all.length !== 8) return null;
	let value = 0n;
	for (const hextet of all) value = (value << 16n) + BigInt(parseInt(hextet || "0", 16));
	return value;
};

const V4_MAPPED_PREFIX = 0xffffn << 32n;

/** An address as a number. IPv4-mapped IPv6 ("::ffff:1.2.3.4") reads as the IPv4 address. */
export const parseIp = (value: unknown): ParsedIp | null => {
	if (typeof value !== "string") return null;
	const text = value.trim().toLowerCase();
	const v4 = parseV4(text);
	if (v4 !== null) return { version: 4, value: v4 };
	const v6 = parseV6(text);
	if (v6 === null) return null;
	if (v6 >> 32n === V4_MAPPED_PREFIX >> 32n) return { version: 4, value: v6 & 0xffffffffn };
	return { version: 6, value: v6 };
};

export const formatIp = (ip: ParsedIp): string => {
	if (ip.version === 4) {
		return [24n, 16n, 8n, 0n].map((shift) => String((ip.value >> shift) & 0xffn)).join(".");
	}
	const parts: string[] = [];
	for (let shift = 112n; shift >= 0n; shift -= 16n) parts.push(((ip.value >> shift) & 0xffffn).toString(16));
	return parts.join(":");
};

export const normalizeIp = (value: unknown): string | null => {
	const ip = parseIp(value);
	return ip ? formatIp(ip) : null;
};

export interface ParsedRange {
	version: 4 | 6;
	network: bigint;
	prefix: number;
}

/** "10.0.0.0/8", "2001:db8::/32". The host bits are cleared, so "10.1.2.3/8" means 10.0.0.0/8. */
export const parseRange = (value: unknown): ParsedRange | null => {
	if (typeof value !== "string") return null;
	const [address, bits, extra] = value.trim().split("/");
	if (extra !== undefined || bits === undefined || !/^\d{1,3}$/.test(bits)) return null;
	const ip = parseIp(address);
	if (!ip) return null;
	const width = ip.version === 4 ? 32 : 128;
	const prefix = Number(bits);
	if (prefix > width) return null;
	// A mapped IPv6 range is only meaningful as IPv4; keep it simple and refuse prefixes that cannot apply.
	const hostBits = BigInt(width - prefix);
	const network = (ip.value >> hostBits) << hostBits;
	return { version: ip.version, network, prefix };
};

export const formatRange = (range: ParsedRange) =>
	`${formatIp({ version: range.version, value: range.network })}/${range.prefix}`;

export const normalizeRange = (value: unknown): string | null => {
	const range = parseRange(value);
	return range ? formatRange(range) : null;
};

export const ipInRange = (ip: ParsedIp, range: ParsedRange) => {
	if (ip.version !== range.version) return false;
	const hostBits = BigInt((ip.version === 4 ? 32 : 128) - range.prefix);
	return ip.value >> hostBits === range.network >> hostBits;
};

/** Smallest prefixes allowed for a range entry, so one entry cannot block a whole continent by mistake. */
export const MIN_RANGE_PREFIX = { 4: 8, 6: 32 } as const;

// --- Entries and matching --------------------------------------------------------------------------------------

/** The stored form of a value for a kind, or null when it is not a valid value of that kind. */
export const normalizeListValue = (kind: ListKind, value: unknown): string | null => {
	switch (kind) {
		case "email":
			return normalizeEmail(value);
		case "email_domain":
			return normalizeDomain(value);
		case "device":
			return normalizeDevice(value);
		case "ip":
			return normalizeIp(value);
		case "ip_range": {
			const range = parseRange(value);
			if (!range || range.prefix < MIN_RANGE_PREFIX[range.version]) return null;
			return formatRange(range);
		}
		case "phone":
			return normalizePhone(value);
	}
};

export interface ListEntry {
	id: string;
	list: ListType;
	kind: ListKind;
	/** Normalised value (normalizeListValue). */
	value: string;
	expiresAt?: Date | number | null;
	removedAt?: Date | number | null;
}

export const isEntryActive = (entry: Pick<ListEntry, "expiresAt" | "removedAt">, now: number) =>
	!entry.removedAt && (!entry.expiresAt || new Date(entry.expiresAt).getTime() > now);

/** What a request presents. Any field may be missing. */
export interface ListSubject {
	email?: string | null;
	phone?: string | null;
	ip?: string | null;
	deviceId?: string | null;
}

export interface ListMatch {
	entry: ListEntry;
	/** Which presented field matched: email, phone, ip or deviceId. */
	field: keyof ListSubject;
}

/** Entries grouped for matching: exact values per kind, ranges parsed once. */
export interface ListIndex {
	exact: Map<string, ListEntry[]>;
	ranges: { entry: ListEntry; range: ParsedRange }[];
}

const exactKey = (list: ListType, kind: ListKind, value: string) => `${list}|${kind}|${value}`;

export const indexEntries = (entries: readonly ListEntry[], now: number): ListIndex => {
	const index: ListIndex = { exact: new Map(), ranges: [] };
	for (const entry of entries) {
		if (!isEntryActive(entry, now)) continue;
		if (entry.kind === "ip_range") {
			const range = parseRange(entry.value);
			if (range) index.ranges.push({ entry, range });
			continue;
		}
		const key = exactKey(entry.list, entry.kind, entry.value);
		const bucket = index.exact.get(key);
		if (bucket) bucket.push(entry);
		else index.exact.set(key, [entry]);
	}
	return index;
};

/** Every active entry of one list that matches what the subject presents. */
export const matchList = (index: ListIndex, list: ListType, subject: ListSubject): ListMatch[] => {
	const matches: ListMatch[] = [];
	const exact = (kind: ListKind, value: string | null, field: keyof ListSubject) => {
		if (!value) return;
		for (const entry of index.exact.get(exactKey(list, kind, value)) ?? []) matches.push({ entry, field });
	};
	const email = normalizeEmail(subject.email);
	exact("email", email, "email");
	if (email) {
		for (const domain of domainAndParents(email.slice(email.indexOf("@") + 1))) {
			exact("email_domain", domain, "email");
		}
	}
	exact("phone", normalizePhone(subject.phone), "phone");
	exact("device", normalizeDevice(subject.deviceId), "deviceId");
	const ip = parseIp(subject.ip);
	if (ip) {
		exact("ip", formatIp(ip), "ip");
		for (const { entry, range } of index.ranges) {
			if (entry.list === list && ipInRange(ip, range)) matches.push({ entry, field: "ip" });
		}
	}
	return matches;
};

export interface ListDecision {
	blocked: boolean;
	block: ListMatch[];
	allow: ListMatch[];
}

/**
 * Blocked when any block entry matches and no allow entry does: an allow entry is the way to let a known person
 * through a blocked network range or a shared device.
 */
export const decideLists = (index: ListIndex, subject: ListSubject): ListDecision => {
	const block = matchList(index, "block", subject);
	const allow = matchList(index, "allow", subject);
	return { blocked: block.length > 0 && allow.length === 0, block, allow };
};
