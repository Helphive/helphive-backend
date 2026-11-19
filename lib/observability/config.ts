// Settings for the observability module, read from the environment. Everything has a default; see
// observability-api.md for the list.
import crypto from "crypto";
import { GOOGLE_CLOUD_PROJECT_ID } from "../../config/config";

const DAY = 24 * 60 * 60 * 1000;

const days = (name: string, fallback: number, max = 400) => {
	const value = Number(process.env[name]);
	return (Number.isFinite(value) && value >= 1 && value <= max ? value : fallback) * DAY;
};

const off = (name: string) => ["true", "1", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());

/** Cloud Run sets K_REVISION and K_SERVICE on every instance. */
export const revision = () => process.env.K_REVISION || "local";
export const service = () => process.env.K_SERVICE || null;
/** RELEASE_COMMIT (set at deploy, e.g. --set-env-vars RELEASE_COMMIT=$SHORT_SHA); null when not set. */
export const releaseCommit = () => (process.env.RELEASE_COMMIT || process.env.COMMIT_SHA || "").slice(0, 64) || null;
export const projectId = () => process.env.GOOGLE_CLOUD_PROJECT || GOOGLE_CLOUD_PROJECT_ID;

export const retention = () => ({
	metrics: days("OBS_METRICS_RETENTION_DAYS", 30),
	errorOccurrences: days("OBS_ERROR_OCCURRENCE_RETENTION_DAYS", 14),
	errorGroups: days("OBS_ERROR_GROUP_RETENTION_DAYS", 90),
	dependencyChecks: days("OBS_DEPENDENCY_RETENTION_DAYS", 30),
	alerts: days("OBS_ALERT_RETENTION_DAYS", 90),
});

/** OBSERVABILITY_DISABLED=true: no metrics, error capture or background work (the read endpoints still answer). */
export const observabilityDisabled = () => off("OBSERVABILITY_DISABLED");
/** OBS_ALERTS_DISABLED=true: no alert evaluation or periodic dependency checks on this service. */
export const alertsDisabled = () => off("OBS_ALERTS_DISABLED");

/** This process, for the evaluator lease. */
export const INSTANCE_ID = `${process.env.K_REVISION || "local"}:${crypto.randomUUID().slice(0, 8)}`;

/** Where alert emails link to. */
export const consoleUrl = () =>
	(process.env.ADMIN_CONSOLE_URL || (process.env.ADMIN_CONSOLE_ORIGINS ?? "").split(",")[0] || "").trim() ||
	"https://admin.helphive.himaiz.com";
