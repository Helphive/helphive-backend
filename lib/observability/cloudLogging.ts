// Reads this service's logs from Cloud Logging (entries:list) as the service's own identity: Application Default
// Credentials, which on Cloud Run is the runtime service account via the metadata server. Needs the Logs Viewer role
// (roles/logging.viewer) on the project for that account; without it the explorer answers "not permitted".
import axios from "axios";
import { buildLogFilter, compactLogEntry, logsConsoleLink, type CompactLogEntry, type LogQuery } from "./logQuery";
import { projectId, service } from "./config";

export type LogsResult =
	| { status: "ok"; entries: CompactLogEntry[]; nextPageToken: string | null; filter: string; consoleUrl: string }
	| {
			status: "not_permitted" | "not_configured" | "unavailable";
			message: string;
			identity: string | null;
			filter: string;
			consoleUrl: string;
	  };

let authClient: any = null;
const auth = () => {
	if (!authClient) {
		// google-auth-library is already installed (a dependency of @google-cloud/storage and @google-cloud/tasks).
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { GoogleAuth } = require("google-auth-library");
		authClient = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/logging.read"] });
	}
	return authClient;
};

let identity: string | null | undefined;
const identityOf = async () => {
	if (identity !== undefined) return identity;
	try {
		const credentials = await auth().getCredentials();
		identity = credentials?.client_email ?? null;
	} catch {
		identity = null;
	}
	return identity;
};

/** Runs a log query. Never throws: permission and configuration problems come back as a status with a message. */
export const queryLogs = async (query: LogQuery): Promise<LogsResult> => {
	const project = projectId();
	const filter = buildLogFilter(query, { project, service: service() ?? undefined });
	const consoleUrl = logsConsoleLink(filter, project, query.from, query.to);
	let token: string | null | undefined;
	try {
		token = await auth().getAccessToken();
	} catch {
		return {
			status: "not_configured",
			message:
				"This server has no Google identity to read logs with (it is not running on Cloud Run and has no application default credentials). Use the Google Cloud link instead.",
			identity: null,
			filter,
			consoleUrl,
		};
	}
	try {
		const { data } = await axios.post(
			"https://logging.googleapis.com/v2/entries:list",
			{
				resourceNames: [`projects/${project}`],
				filter,
				orderBy: "timestamp desc",
				pageSize: query.pageSize,
				...(query.pageToken ? { pageToken: query.pageToken } : {}),
			},
			{ headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
		);
		return {
			status: "ok",
			entries: (data?.entries ?? []).map((entry: Record<string, unknown>) => compactLogEntry(entry, project)),
			nextPageToken: data?.nextPageToken ?? null,
			filter,
			consoleUrl,
		};
	} catch (error: any) {
		const status = error?.response?.status;
		if (status === 403 || status === 401) {
			const who = await identityOf();
			return {
				status: "not_permitted",
				message: `The service account${who ? ` ${who}` : ""} may not read logs. Grant it the Logs Viewer role (roles/logging.viewer) on project ${project}.`,
				identity: who ?? null,
				filter,
				consoleUrl,
			};
		}
		if (status === 429) {
			return {
				status: "unavailable",
				message: "Cloud Logging's read quota is used up for this minute. Try again shortly.",
				identity: null,
				filter,
				consoleUrl,
			};
		}
		if (status === 400) {
			return {
				status: "unavailable",
				message: `Cloud Logging refused the query: ${String(error?.response?.data?.error?.message ?? "invalid filter").slice(0, 300)}`,
				identity: null,
				filter,
				consoleUrl,
			};
		}
		return {
			status: "unavailable",
			message: "Cloud Logging did not answer. Try again, or use the Google Cloud link.",
			identity: null,
			filter,
			consoleUrl,
		};
	}
};
