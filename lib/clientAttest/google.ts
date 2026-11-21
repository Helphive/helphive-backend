// The two Google calls behind attestation, using Application Default Credentials (the Cloud Run service account).
// Injectable (AttestGoogle) so tests never reach the network.
import { GoogleAuth } from "google-auth-library";
import { ANDROID_APP_ID } from "../appIdentity";
import { ATTEST_ACTION, cloudProjectId } from "./config";

/** A failed Google call: `status` is the HTTP status when Google answered, absent for network errors. */
export class GoogleCallError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "GoogleCallError";
	}
}

export interface AttestGoogle {
	/** Google's decode response (with `tokenPayloadExternal`). */
	decodeIntegrityToken(integrityToken: string): Promise<unknown>;
	/** The reCAPTCHA Enterprise assessment for a web token. */
	createAssessment(input: { token: string; siteKey: string; userAgent?: string; ip?: string }): Promise<unknown>;
}

const clients = new Map<string, GoogleAuth>();

const post = async (scope: string, url: string, data: unknown) => {
	let auth = clients.get(scope);
	if (!auth) clients.set(scope, (auth = new GoogleAuth({ scopes: [scope] })));
	try {
		return (await auth.request({ url, method: "POST", data, timeout: 10_000 })).data;
	} catch (error) {
		const status = (error as { response?: { status?: unknown }; status?: unknown })?.response?.status;
		const own = (error as { status?: unknown })?.status;
		const code = typeof status === "number" ? status : typeof own === "number" ? own : undefined;
		throw new GoogleCallError(error instanceof Error ? error.message : String(error), code);
	}
};

export const googleAttest: AttestGoogle = {
	decodeIntegrityToken: (integrityToken) =>
		post(
			"https://www.googleapis.com/auth/playintegrity",
			`https://playintegrity.googleapis.com/v1/${ANDROID_APP_ID}:decodeIntegrityToken`,
			{ integrityToken },
		),
	createAssessment: ({ token, siteKey, userAgent, ip }) =>
		post(
			"https://www.googleapis.com/auth/cloud-platform",
			`https://recaptchaenterprise.googleapis.com/v1/projects/${cloudProjectId()}/assessments`,
			{ event: { token, siteKey, expectedAction: ATTEST_ACTION, userAgent, userIpAddress: ip } },
		),
};
