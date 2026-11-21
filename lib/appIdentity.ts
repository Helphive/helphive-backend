// Everything the server knows about the mobile apps' identity: the Android application ids and signing-certificate
// fingerprints behind /.well-known/assetlinks.json, the URL schemes each app registers, and which app (or the web
// app) started a Stripe onboarding flow so its return link can send the person back to the right place.
// Pure functions; index.ts and the provider controller use them. See scratch/mobile/app-identity-contract.md.
import type { IncomingHttpHeaders } from "http";

/** The new Android application id (from the release that renames the app) and the one installs still carry. */
export const ANDROID_APP_ID = "com.himaiz.helphive.app";
export const LEGACY_ANDROID_APP_ID = "com.helphivenow.app";

/** Upload/app signing key shared by both ids (owner-provided). */
export const SIGNING_KEY_SHA256 =
	"D4:9A:E6:C7:71:64:FB:1A:E9:3C:C4:AE:C4:7D:AA:F7:89:5D:78:91:E2:4A:D5:B3:F4:98:5F:9D:D0:B4:7C:E5";
/** Google Play app signing key of the old listing (closed testing), as published before this change. */
const LEGACY_PLAY_SIGNING_SHA256 =
	"4C:E9:24:F9:5D:99:74:F5:4F:80:8F:0E:23:69:95:0B:0C:73:9F:A3:2D:82:F3:3D:07:C1:BE:F5:DD:54:44:99";

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * Extra SHA-256 fingerprints for the new app id (comma separated), e.g. the Play app signing key once the new listing
 * exists. Invalid entries are ignored.
 */
export const extraFingerprints = (value = process.env.ANDROID_APP_EXTRA_SHA256) =>
	(value ?? "")
		.split(",")
		.map((entry) => entry.trim().toUpperCase())
		.filter((entry) => FINGERPRINT.test(entry));

const unique = (values: string[]) => [...new Set(values)];

/** The Digital Asset Links statement list served at /.well-known/assetlinks.json. */
export const buildAssetLinks = (extra: string[] = extraFingerprints()) => {
	const relation = ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"];
	const statement = (packageName: string, fingerprints: string[]) => ({
		relation,
		target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: unique(fingerprints) },
	});
	return [
		statement(ANDROID_APP_ID, [SIGNING_KEY_SHA256, ...extra]),
		statement(LEGACY_ANDROID_APP_ID, [SIGNING_KEY_SHA256, LEGACY_PLAY_SIGNING_SHA256]),
	];
};

/**
 * Who started a flow: the installed (legacy) mobile app, the renamed mobile app, or the web app. Carried as `?app=` on
 * links this server hands out, so the server can answer the return correctly even though the browser that comes back
 * sends none of the app's headers.
 */
export type AppFlavor = "legacy" | "app" | "web";
export const APP_FLAVORS: readonly AppFlavor[] = ["legacy", "app", "web"];

const firstHeader = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim();

/**
 * The flavor of the client making a request. The renamed app sends `X-App-Id: com.himaiz.helphive.app` (new header);
 * the web app sends `X-App-Platform: web`. Anything else, including today's installed app which sends neither, is
 * treated as the legacy app, which is exactly what the server did before.
 */
export const appFlavorFromHeaders = (headers: IncomingHttpHeaders): AppFlavor => {
	const appId = firstHeader(headers["x-app-id"])?.toLowerCase();
	if (appId === ANDROID_APP_ID) return "app";
	if (appId === LEGACY_ANDROID_APP_ID) return "legacy";
	if (firstHeader(headers["x-app-platform"])?.toLowerCase() === "web") return "web";
	return "legacy";
};

/** A flavor from a query value, or null when it is missing or not one of the known ones. */
export const parseAppFlavor = (value: unknown): AppFlavor | null =>
	typeof value === "string" && (APP_FLAVORS as readonly string[]).includes(value) ? (value as AppFlavor) : null;

export const LEGACY_SCHEME = "helphivenow";
export const APP_SCHEME = "helphive";

const DEFAULT_WEB_APP_URL = "https://helphive.himaiz.com";

/** The web app's origin (WEB_APP_URL, https only); falls back to the production web app. */
export const webAppUrl = (value = process.env.WEB_APP_URL) => {
	try {
		const url = new URL(value ?? "");
		if (url.protocol === "https:" && !url.username && !url.password) return url.origin;
	} catch {
		// Fall through to the default.
	}
	return DEFAULT_WEB_APP_URL;
};

/** Stripe's refresh and return URLs for onboarding, marked with the flavor that asked for the link. */
export const stripeOnboardingUrls = (serverBaseUrl: string, flavor: AppFlavor) => ({
	refresh_url: `${serverBaseUrl}/stripe-onboarding?refresh=true&app=${flavor}`,
	return_url: `${serverBaseUrl}/stripe-onboarding?app=${flavor}`,
});

/**
 * Where /stripe-onboarding sends the browser. Links made before this change carry no `app`, and an unknown value is
 * treated the same way: the legacy scheme, as before, so an installed app keeps working.
 */
export const stripeOnboardingRedirect = (flavor: AppFlavor | null, refresh: boolean, webBase = webAppUrl()) => {
	const flag = refresh ? "true" : "false";
	switch (flavor) {
		case "app":
			return `${APP_SCHEME}://stripe-onboarding?refresh=${flag}`;
		case "web":
			return `${webBase}/provider/earnings?stripe=${refresh ? "refresh" : "return"}`;
		default:
			return `${LEGACY_SCHEME}://stripe-onboarding?refresh=${flag}`;
	}
};

/**
 * Links into the renamed app: `helphive://<path>` and the verified https form `https://api.helphive.himaiz.com/app/<path>`
 * (App Links open the app directly when it is installed). When the https form reaches this server instead (no app,
 * older app, desktop), the person is sent to the same place in the web app. Only known paths are accepted.
 */
export const APP_LINK_PATHS = [/^chat\/[a-f\d]{24}$/, /^bookings\/[a-f\d]{24}$/];

export const appLinkWebFallback = (path: string, webBase = webAppUrl()): string | null => {
	const clean = path.replace(/^\/+/, "");
	return APP_LINK_PATHS.some((pattern) => pattern.test(clean)) ? `${webBase}/${clean}` : null;
};

/** The two forms of an in-app link for a path such as "chat/<uid>". */
export const appLinks = (path: string, serverBaseUrl: string) => ({
	scheme: `${APP_SCHEME}://${path}`,
	https: `${serverBaseUrl}/app/${path}`,
});
