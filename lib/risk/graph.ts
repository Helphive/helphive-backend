// Linked accounts: who is connected to whom through shared devices, network addresses, phone numbers, payout bank
// details, booking addresses or repeated pairings. Pure: links derived from a dataset, and a breadth-first graph
// builder with depth and size limits (the loader per person is in lib/risk/engine.ts).
import { normalizeDevice, normalizeIp, normalizePhone } from "./lists";
import { normalizeAddress, type DatasetIndex } from "./signals";

const DAY = 24 * 60 * 60 * 1000;

export const LINK_KINDS = ["device", "ip", "phone", "payout_destination", "booking_address", "pairing"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_LABELS: Record<LinkKind, string> = {
	device: "Shared device",
	ip: "Shared network address",
	phone: "Same phone number",
	payout_destination: "Same payout bank details",
	booking_address: "Booked the same address",
	pairing: "Repeated bookings together",
};

/** Strength orders links when a node has more than the limit: stronger links are kept first. */
export const LINK_STRENGTH: Record<LinkKind, number> = {
	payout_destination: 5,
	phone: 4,
	device: 4,
	pairing: 3,
	booking_address: 2,
	ip: 1,
};

export interface Link {
	from: string;
	to: string;
	kind: LinkKind;
	/** How many shared things or bookings back the link. */
	count: number;
}

/** A network address used by more accounts than this is a hotel or a carrier, not a link between people. */
export const BUSY_NETWORK_ACCOUNTS = 10;
export const PAIRING_MIN_BOOKINGS = 3;

/** Links from one person to others, from a dataset loaded around them, as of a moment. */
export const linksFromIndex = (index: DatasetIndex, userId: string, asOf: number): Link[] => {
	const counts = new Map<string, Link>();
	const add = (to: string, kind: LinkKind, by = 1) => {
		if (!to || to === userId) return;
		const key = `${kind}|${to}`;
		const link = counts.get(key);
		if (link) link.count += by;
		else counts.set(key, { from: userId, to, kind, count: by });
	};
	const recent = (at: number, windowMs: number) => at <= asOf && at > asOf - windowMs;

	const own = (kind: "device" | "ip", windowMs: number) => {
		const values = new Set<string>();
		for (const event of index.eventsByOwner.get(userId) ?? []) {
			if (!recent(event.at, windowMs)) continue;
			const value = kind === "device" ? normalizeDevice(event.deviceId) : normalizeIp(event.ip);
			if (value) values.add(value);
		}
		const user = index.users.get(userId);
		for (const raw of kind === "device" ? (user?.sessionDevices ?? []) : (user?.sessionIps ?? [])) {
			const value = kind === "device" ? normalizeDevice(raw) : normalizeIp(raw);
			if (value) values.add(value);
		}
		return values;
	};
	for (const device of own("device", 90 * DAY)) {
		const owners = new Set((index.deviceUse.get(device) ?? []).map((u) => u.owner));
		for (const owner of owners) add(owner, "device");
	}
	for (const ip of own("ip", 30 * DAY)) {
		const owners = new Set((index.ipUse.get(ip) ?? []).filter((u) => recent(u.at, 30 * DAY)).map((u) => u.owner));
		if (owners.size > BUSY_NETWORK_ACCOUNTS) continue;
		for (const owner of owners) add(owner, "ip");
	}
	const phone = normalizePhone(index.users.get(userId)?.phone);
	if (phone) for (const other of index.usersByPhone.get(phone) ?? []) add(other, "phone");
	const destinations = new Set(
		(index.payoutsByProvider.get(userId) ?? []).map((p) => p.destination).filter(Boolean) as string[],
	);
	for (const destination of destinations) {
		const providers = new Set((index.payoutsByDestination.get(destination) ?? []).map((p) => p.providerId));
		for (const provider of providers) add(provider, "payout_destination");
	}
	const addresses = new Set(
		(index.bookingsByCustomer.get(userId) ?? [])
			.map((b) => normalizeAddress(b.address))
			.filter(Boolean) as string[],
	);
	for (const address of addresses) {
		const customers = new Set((index.bookingsByAddress.get(address) ?? []).map((b) => b.userId));
		for (const customer of customers) add(customer, "booking_address");
	}
	const together = new Map<string, number>();
	for (const booking of [
		...(index.bookingsByCustomer.get(userId) ?? []),
		...(index.bookingsByProvider.get(userId) ?? []),
	]) {
		if (!booking.providerId || booking.createdAt > asOf) continue;
		if (booking.status === "cancelled" && !booking.acceptedAt) continue;
		const other = booking.userId === userId ? booking.providerId : booking.userId;
		together.set(other, (together.get(other) ?? 0) + 1);
	}
	for (const [other, n] of together) if (n >= PAIRING_MIN_BOOKINGS) add(other, "pairing", n);
	return [...counts.values()];
};

export interface GraphLimits {
	/** Hops from the person (1-3). */
	depth: number;
	/** Most people in the graph, the person included. */
	maxNodes: number;
	/** Most links followed from any one person (strongest first). */
	maxLinksPerNode: number;
}

export const DEFAULT_GRAPH_LIMITS: GraphLimits = { depth: 2, maxNodes: 40, maxLinksPerNode: 15 };
export const MAX_GRAPH_LIMITS: GraphLimits = { depth: 3, maxNodes: 100, maxLinksPerNode: 30 };

export interface GraphNode {
	id: string;
	depth: number;
}

export interface GraphEdge {
	source: string;
	target: string;
	kinds: { kind: LinkKind; label: string; count: number }[];
	strength: number;
}

export interface LinkGraph {
	root: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** True when a limit cut the graph short (more people or links exist). */
	truncated: boolean;
	limits: GraphLimits;
}

export const clampLimits = (input: Partial<GraphLimits>): GraphLimits => {
	const clamp = (value: number | undefined, fallback: number, max: number) =>
		Number.isInteger(value) && (value as number) >= 1 ? Math.min(value as number, max) : fallback;
	return {
		depth: clamp(input.depth, DEFAULT_GRAPH_LIMITS.depth, MAX_GRAPH_LIMITS.depth),
		maxNodes: Math.max(2, clamp(input.maxNodes, DEFAULT_GRAPH_LIMITS.maxNodes, MAX_GRAPH_LIMITS.maxNodes)),
		maxLinksPerNode: clamp(
			input.maxLinksPerNode,
			DEFAULT_GRAPH_LIMITS.maxLinksPerNode,
			MAX_GRAPH_LIMITS.maxLinksPerNode,
		),
	};
};

/**
 * Breadth first from the person, one level at a time, until the depth or the node limit. Links of each person are
 * taken strongest first up to maxLinksPerNode. Deterministic: ties break on the other person's id.
 */
export const buildLinkGraph = async (
	root: string,
	getLinks: (userId: string) => Promise<Link[]> | Link[],
	limits: GraphLimits = DEFAULT_GRAPH_LIMITS,
): Promise<LinkGraph> => {
	const nodes = new Map<string, GraphNode>([[root, { id: root, depth: 0 }]]);
	const edges = new Map<string, GraphEdge>();
	let truncated = false;
	let frontier = [root];
	for (let depth = 1; depth <= limits.depth && frontier.length; depth++) {
		const next: string[] = [];
		const linkLists = await Promise.all(frontier.map(async (id) => ({ id, links: await getLinks(id) })));
		for (const { id, links } of linkLists) {
			const strongest = new Map<string, Link[]>();
			for (const link of links) {
				if (link.to === id) continue;
				const bucket = strongest.get(link.to);
				if (bucket) bucket.push(link);
				else strongest.set(link.to, [link]);
			}
			const ranked = [...strongest.entries()]
				.map(([other, ls]) => ({ other, ls, strength: ls.reduce((s, l) => s + LINK_STRENGTH[l.kind], 0) }))
				.sort((a, b) => b.strength - a.strength || (a.other < b.other ? -1 : 1));
			if (ranked.length > limits.maxLinksPerNode) truncated = true;
			for (const { other, ls } of ranked.slice(0, limits.maxLinksPerNode)) {
				if (!nodes.has(other)) {
					if (nodes.size >= limits.maxNodes) {
						truncated = true;
						continue;
					}
					nodes.set(other, { id: other, depth });
					next.push(other);
				}
				const [source, target] = id < other ? [id, other] : [other, id];
				const key = `${source}|${target}`;
				const edge = edges.get(key) ?? { source, target, kinds: [], strength: 0 };
				for (const link of ls) {
					if (edge.kinds.some((k) => k.kind === link.kind)) continue;
					edge.kinds.push({ kind: link.kind, label: LINK_LABELS[link.kind], count: link.count });
					edge.strength += LINK_STRENGTH[link.kind];
				}
				edges.set(key, edge);
			}
		}
		frontier = next;
	}
	// People at the last level may have further links we did not follow; that is the depth limit, not truncation.
	return {
		root,
		nodes: [...nodes.values()],
		edges: [...edges.values()].sort((a, b) => (a.source + a.target < b.source + b.target ? -1 : 1)),
		truncated,
		limits,
	};
};
