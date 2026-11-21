// Health checks of what the service depends on. Each check is one cheap, read-only call with a 5-second timeout.
// Results are cached for a minute (so the console can ask freely) and recorded as a small history for uptime: by the
// alert evaluator every 5 minutes, and whenever an admin forces a fresh check.
import axios from "axios";
import mongoose from "mongoose";
import { DependencyCheckModel, type DependencyStatus } from "../../dal/models/obsOps.model";
import { COMET_CHAT_BASE_URL, GOOGLE_CLOUD_TASKS_QUEUE_PATH } from "../../config/config";
import { retention } from "./config";

export interface DependencyResult {
	name: string;
	label: string;
	status: DependencyStatus;
	latencyMs: number | null;
	error: string | null;
	checkedAt: string;
}

const TIMEOUT_MS = 5000;

type Probe = () => Promise<{ status?: DependencyStatus; note?: string } | void>;

const withTimeout = async <T>(work: Promise<T>, ms = TIMEOUT_MS): Promise<T> => {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

const httpError = (error: any) => {
	const status = error?.response?.status;
	const code = error?.response?.data?.name ?? error?.response?.data?.code ?? error?.code;
	return status
		? `HTTP ${status}${code ? ` (${String(code).slice(0, 60)})` : ""}`
		: String(error?.message ?? error).slice(0, 300);
};

/** Configured when every named variable is set. */
const configured = (...names: string[]) => names.every((name) => !!process.env[name]);

export const DEPENDENCIES: { name: string; label: string; enabled: () => boolean; probe: Probe }[] = [
	{
		name: "mongodb",
		label: "MongoDB",
		enabled: () => true,
		probe: async () => {
			const db = mongoose.connection.db;
			if (mongoose.connection.readyState !== 1 || !db) throw new Error("not connected");
			await db.admin().command({ ping: 1 });
		},
	},
	{
		name: "stripe",
		label: "Stripe",
		enabled: () => configured("STRIPE_SECRET_KEY"),
		probe: async () => {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const stripe = require("../../controllers/service-accounts/stripe").default;
			await stripe.balance.retrieve();
		},
	},
	{
		name: "onesignal",
		label: "OneSignal",
		enabled: () => configured("ONE_SIGNAL_APP_ID", "ONE_SIGNAL_REST_API_KEY"),
		probe: async () => {
			await axios.get("https://api.onesignal.com/notifications", {
				params: { app_id: process.env.ONE_SIGNAL_APP_ID, limit: 1 },
				headers: { Authorization: `Basic ${process.env.ONE_SIGNAL_REST_API_KEY}` },
				timeout: TIMEOUT_MS,
			});
		},
	},
	{
		name: "cometchat",
		label: "CometChat",
		enabled: () => configured("COMETCHAT_REST_API_KEY") || configured("COMET_CHAT_REST_API_KEY"),
		probe: async () => {
			await axios.get(`${COMET_CHAT_BASE_URL}/users`, {
				params: { perPage: 1 },
				headers: {
					apiKey: process.env.COMETCHAT_REST_API_KEY || process.env.COMET_CHAT_REST_API_KEY,
					accept: "application/json",
				},
				timeout: TIMEOUT_MS,
			});
		},
	},
	{
		name: "resend",
		label: "Resend (email)",
		enabled: () => configured("RESEND_API_KEY"),
		probe: async () => {
			try {
				await axios.get("https://api.resend.com/domains", {
					headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
					timeout: TIMEOUT_MS,
				});
			} catch (error: any) {
				// A sending-only key may not list domains; Resend answered and knew the key, which is what matters.
				if (error?.response?.data?.name === "restricted_api_key") return { note: "sending-only key" };
				throw error;
			}
		},
	},
	{
		name: "cloud-tasks",
		label: "Cloud Tasks queue",
		enabled: () => true,
		probe: async () => {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { googleCloudTasks } = require("../../controllers/service-accounts/cloud-tasks");
			try {
				const [queue] = await googleCloudTasks.getQueue({ name: GOOGLE_CLOUD_TASKS_QUEUE_PATH });
				if (queue?.state && queue.state !== "RUNNING")
					return { status: "degraded", note: `queue is ${queue.state}` };
			} catch (error: any) {
				// PERMISSION_DENIED: the queue answered but this key may only create tasks (no cloudtasks.queues.get).
				if (error?.code === 7)
					return { status: "degraded", note: "reachable; the key cannot read the queue state" };
				throw error;
			}
		},
	},
	{
		name: "google-maps",
		label: "Google Maps",
		enabled: () => configured("GOOGLE_MAPS_SERVER_API_KEY") || configured("GOOGLE_MAPS_API_KEY"),
		probe: async () => {
			const { data } = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
				params: {
					address: "London",
					key: process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.GOOGLE_MAPS_API_KEY,
				},
				timeout: TIMEOUT_MS,
			});
			if (data?.status && !["OK", "ZERO_RESULTS"].includes(data.status)) {
				return { status: "down", note: String(data.status) };
			}
		},
	},
];

export const runCheck = async (dependency: (typeof DEPENDENCIES)[number]): Promise<DependencyResult> => {
	const base = { name: dependency.name, label: dependency.label, checkedAt: new Date().toISOString() };
	if (!dependency.enabled()) return { ...base, status: "unconfigured", latencyMs: null, error: null };
	const started = Date.now();
	try {
		const outcome = await withTimeout(dependency.probe());
		return {
			...base,
			status: outcome?.status ?? "up",
			latencyMs: Date.now() - started,
			error: outcome?.note ?? null,
		};
	} catch (error) {
		return { ...base, status: "down", latencyMs: Date.now() - started, error: httpError(error) };
	}
};

const CACHE_MS = 60_000;
let cache: { at: number; results: DependencyResult[] } | null = null;
let inFlight: Promise<DependencyResult[]> | null = null;

/** Every dependency's status: cached for a minute unless `fresh`; a fresh run is recorded in the history. */
export const checkDependencies = async (options: { fresh?: boolean; record?: boolean } = {}) => {
	if (!options.fresh && cache && Date.now() - cache.at < CACHE_MS)
		return { results: cache.results, cachedAt: cache.at };
	inFlight ??= Promise.all(DEPENDENCIES.map(runCheck)).finally(() => {
		inFlight = null;
	});
	const results = await inFlight;
	cache = { at: Date.now(), results };
	if (options.record !== false && mongoose.connection.readyState === 1) {
		const keep = retention().dependencyChecks;
		const now = new Date();
		await DependencyCheckModel.insertMany(
			results
				.filter((r) => r.status !== "unconfigured")
				.map((r) => ({
					at: now,
					name: r.name,
					status: r.status,
					latencyMs: r.latencyMs,
					error: r.error,
					expireAt: new Date(now.getTime() + keep),
				})),
			{ ordered: false },
		).catch(() => undefined);
	}
	return { results, cachedAt: cache.at };
};

/** Minutes each dependency has been down without a break, from its checks (newest first). Pure. */
export const downMinutes = (checksNewestFirst: { name: string; status: string; at: Date }[], now: Date) => {
	const result: Record<string, number> = {};
	const done = new Set<string>();
	const firstDown: Record<string, Date> = {};
	for (const check of checksNewestFirst) {
		if (done.has(check.name)) continue;
		if (check.status === "down") {
			firstDown[check.name] = check.at;
			result[check.name] = Math.floor((now.getTime() - check.at.getTime()) / 60_000);
		} else {
			done.add(check.name);
			result[check.name] ??= 0;
		}
	}
	return result;
};
