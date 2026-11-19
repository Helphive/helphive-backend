// Run with: node -r ts-node/register/transpile-only --test tests/appIdentity.test.ts
// App identity: the assetlinks document for both application ids, which app started a Stripe onboarding flow, where
// its return goes, the https app-link fallback, and the earnings release settings shown to admins and providers.
import test from "node:test";
import assert from "node:assert/strict";
import {
	ANDROID_APP_ID,
	LEGACY_ANDROID_APP_ID,
	appFlavorFromHeaders,
	appLinkWebFallback,
	buildAssetLinks,
	extraFingerprints,
	parseAppFlavor,
	stripeOnboardingRedirect,
	stripeOnboardingUrls,
	webAppUrl,
} from "../lib/appIdentity";
import { describeDelay, earningsReleaseDelaySeconds, releasePolicy, stripeMode } from "../lib/platformSettings";

const KEY = "D4:9A:E6:C7:71:64:FB:1A:E9:3C:C4:AE:C4:7D:AA:F7:89:5D:78:91:E2:4A:D5:B3:F4:98:5F:9D:D0:B4:7C:E5";

test("assetlinks: both application ids, the shared signing key, the old Play key kept for the old id", () => {
	const doc = buildAssetLinks([]);
	assert.equal(doc.length, 2);
	const byPackage = Object.fromEntries(doc.map((s) => [s.target.package_name, s]));
	assert.deepEqual(Object.keys(byPackage).sort(), [ANDROID_APP_ID, LEGACY_ANDROID_APP_ID].sort());
	for (const statement of doc) {
		assert.equal(statement.target.namespace, "android_app");
		assert.ok(statement.relation.includes("delegate_permission/common.handle_all_urls"));
		assert.ok(statement.target.sha256_cert_fingerprints.includes(KEY));
	}
	assert.deepEqual(byPackage[ANDROID_APP_ID].target.sha256_cert_fingerprints, [KEY]);
	assert.equal(byPackage[LEGACY_ANDROID_APP_ID].target.sha256_cert_fingerprints.length, 2);
	assert.doesNotThrow(() => JSON.parse(JSON.stringify(doc)));
});

test("assetlinks: extra fingerprints from the environment, invalid ones ignored, no duplicates", () => {
	const play = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
	assert.deepEqual(extraFingerprints(`${play.toLowerCase()}, not-a-key, ${KEY}`), [play, KEY]);
	const doc = buildAssetLinks(extraFingerprints(`${play},${KEY}`));
	assert.deepEqual(doc[0].target.sha256_cert_fingerprints, [KEY, play]);
	assert.deepEqual(extraFingerprints(undefined), []);
});

test("which app asked: new app by X-App-Id, web by platform, anything else is the installed (legacy) app", () => {
	assert.equal(appFlavorFromHeaders({ "x-app-id": ANDROID_APP_ID }), "app");
	assert.equal(
		appFlavorFromHeaders({ "x-app-id": ANDROID_APP_ID.toUpperCase(), "x-app-platform": "android" }),
		"app",
	);
	assert.equal(appFlavorFromHeaders({ "x-app-id": LEGACY_ANDROID_APP_ID, "x-app-platform": "web" }), "legacy");
	assert.equal(appFlavorFromHeaders({ "x-app-platform": "web" }), "web");
	assert.equal(appFlavorFromHeaders({ "x-app-platform": "android" }), "legacy", "today's installed app");
	assert.equal(appFlavorFromHeaders({}), "legacy");
	assert.equal(appFlavorFromHeaders({ "x-app-id": "com.evil.app" }), "legacy");
});

test("Stripe URLs carry the marker; the return goes to the right place and falls back to the old scheme", () => {
	assert.deepEqual(stripeOnboardingUrls("https://api.helphive.himaiz.com", "app"), {
		refresh_url: "https://api.helphive.himaiz.com/stripe-onboarding?refresh=true&app=app",
		return_url: "https://api.helphive.himaiz.com/stripe-onboarding?app=app",
	});
	const web = "https://helphive.himaiz.com";
	assert.equal(stripeOnboardingRedirect("app", false, web), "helphive://stripe-onboarding?refresh=false");
	assert.equal(stripeOnboardingRedirect("app", true, web), "helphive://stripe-onboarding?refresh=true");
	assert.equal(stripeOnboardingRedirect("legacy", true, web), "helphivenow://stripe-onboarding?refresh=true");
	assert.equal(stripeOnboardingRedirect("web", false, web), `${web}/provider/earnings?stripe=return`);
	assert.equal(stripeOnboardingRedirect("web", true, web), `${web}/provider/earnings?stripe=refresh`);
	// Links issued before this change have no marker: exactly today's redirect.
	assert.equal(
		stripeOnboardingRedirect(parseAppFlavor(undefined), false, web),
		"helphivenow://stripe-onboarding?refresh=false",
	);
	assert.equal(parseAppFlavor("javascript:alert(1)"), null);
	assert.equal(parseAppFlavor(["app"]), null);
	assert.equal(parseAppFlavor("web"), "web");
});

test("web app URL: https origins only, anything else falls back to production", () => {
	assert.equal(webAppUrl("https://staging.helphive.himaiz.com/some/path"), "https://staging.helphive.himaiz.com");
	assert.equal(webAppUrl("http://evil.example"), "https://helphive.himaiz.com");
	assert.equal(webAppUrl("https://user:pass@evil.example"), "https://helphive.himaiz.com");
	assert.equal(webAppUrl("not a url"), "https://helphive.himaiz.com");
	assert.equal(webAppUrl(undefined), "https://helphive.himaiz.com");
});

test("https app links fall back to the same page of the web app, known paths only", () => {
	const web = "https://helphive.himaiz.com";
	assert.equal(appLinkWebFallback("chat/64b7f0c2a1b2c3d4e5f60719", web), `${web}/chat/64b7f0c2a1b2c3d4e5f60719`);
	assert.equal(
		appLinkWebFallback("bookings/64b7f0c2a1b2c3d4e5f60719", web),
		`${web}/bookings/64b7f0c2a1b2c3d4e5f60719`,
	);
	assert.equal(appLinkWebFallback("chat/../../admin", web), null);
	assert.equal(appLinkWebFallback("//evil.example/chat/x", web), null);
	assert.equal(appLinkWebFallback("", web), null);
});

test("earnings release: 30 seconds by default (test mode), configurable, shown with the Stripe mode", () => {
	assert.equal(earningsReleaseDelaySeconds({}), 30);
	assert.equal(earningsReleaseDelaySeconds({ EARNINGS_RELEASE_DELAY_SECONDS: "259200" }), 259200);
	assert.equal(earningsReleaseDelaySeconds({ EARNINGS_RELEASE_DELAY_SECONDS: "-5" }), 30);
	assert.equal(stripeMode("sk_test_abc"), "test");
	assert.equal(stripeMode("rk_live_abc"), "live");
	assert.equal(stripeMode(undefined), "unknown");
	assert.equal(describeDelay(30), "30 seconds");
	assert.equal(describeDelay(3600), "1 hour");
	assert.equal(describeDelay(259200), "3 days");
	assert.equal(describeDelay(90), "90 seconds");
	assert.deepEqual(releasePolicy({ STRIPE_SECRET_KEY: "sk_test_x" }), {
		delaySeconds: 30,
		stripeMode: "test",
		testMode: true,
		notice: "Test mode: provider earnings are released 30 seconds after completion.",
	});
	const live = releasePolicy({ STRIPE_SECRET_KEY: "sk_live_x", EARNINGS_RELEASE_DELAY_SECONDS: "259200" });
	assert.equal(live.notice, "Provider earnings are released 3 days after completion.");
	assert.equal(JSON.stringify(live).includes("sk_live"), false, "the key is never returned");
});
