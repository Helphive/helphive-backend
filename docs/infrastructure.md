# HelpHive infrastructure and deployment

How every part of HelpHive is hosted, deployed, protected and rolled back. Checked against the live setup on
2026-11-22. This repo holds the API and its Cloudflare edge Worker; the website, admin console and Android app have
their own repos, and each README's Deployment section covers its own part and links back here for the shared pieces.

## What runs where

| Part          | Repo                      | Runs on                                                                               | Public address                              |
| ------------- | ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| Website       | `Helphive/helphive-web`   | Cloudflare Worker `helphive-web` (static assets)                                      | `https://helphive.himaiz.com`               |
| Admin console | `Helphive/helphive-admin` | Cloudflare Worker `helphive-admin` (static assets)                                    | `https://admin.helphive.himaiz.com`         |
| API edge      | this repo, `edge/api`     | Cloudflare Worker `helphive-api-edge`                                                 | `https://api.helphive.himaiz.com`           |
| API           | this repo                 | Google Cloud Run service `helphive-backend`, project `helphive`, region `us-central1` | only through the API edge                   |
| Android app   | `Helphive/helphive-app`   | APK files on GitHub Releases                                                          | `github.com/Helphive/helphive-app/releases` |
| Database      | —                         | MongoDB Atlas                                                                         | —                                           |

The old Firebase Hosting sites (`*.web.app`) are disabled and return 404. Nothing is hosted on Vercel or App Engine.

## Domains

All hostnames are in the shared Cloudflare zone `himaiz.com`.

| Hostname                                                                                                   | Record                         | Served by                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| `helphive.himaiz.com`                                                                                      | Worker custom domain (proxied) | Worker `helphive-web`                                   |
| `admin.helphive.himaiz.com`                                                                                | Worker custom domain (proxied) | Worker `helphive-admin`                                 |
| `api.helphive.himaiz.com`                                                                                  | Worker custom domain (proxied) | Worker `helphive-api-edge`, which forwards to Cloud Run |
| `send.helphive.himaiz.com` (MX, SPF), `rsend.helphive.himaiz.com`, `resend._domainkey.helphive.himaiz.com` | DNS only, by design            | Resend (outgoing email)                                 |

## Google Cloud (project `helphive`)

- **Cloud Run** `helphive-backend` (`us-central1`): at most 2 instances, 4 vCPU and 4 GiB each, startup CPU boost.
  A startup probe on `/readyz` (every second, up to 120 tries) means a new revision only takes traffic once its
  database answers. Ingress is open, but every request without the edge's secret is refused (see Cloudflare below).
- **Runtime identity:** the default compute service account, through Application Default Credentials, with no key.
  The account may create tokens for itself, which lets it sign Cloud Storage URLs.
- **Service accounts:** besides the runtime account (and App Engine's default one), only `firebase-adminsdk-…`
  remains. It holds the project's only service-account key, which OneSignal uses to send Android pushes through
  Firebase Cloud Messaging.
- **Artifact Registry** repo `cloud-run-source-deploy` (`us-central1`): holds the image only during a deploy. A cleanup
  policy deletes images older than a day, and the deploy pipeline deletes them right after deploying. Cloud Run keeps
  its own copy of the running image.
- **Cloud Tasks** queue `helphive-app-queue` (`us-central1`): delayed jobs. Each task calls
  `POST https://api.helphive.himaiz.com/webhook/google-cloud-tasks/...` with a bearer secret.
- **Cloud Storage:** `helphive-users` (profile pictures), `helphive-provider-applications` (provider documents,
  private, opened through signed URLs), `helphive-public` (public assets), `helphive_cloudbuild` (Cloud Build's own).
- **Secret Manager:** `helphive-secrets` (see Secrets).
- **API keys:** "HelpHive web (browser)" (Maps, `helphive.himaiz.com` only), "HelpHive web (local dev)" (localhost
  only), "HelpHive Android (com.himaiz.helphive.app)", "HelpHive server (places and geocoding)".
- **reCAPTCHA Enterprise** key "HelpHive web client attestation" (score key, domain `helphive.himaiz.com`) and
  **Play Integrity** through this Cloud project (see Client attestation).

## CI

- `.github/workflows/lint.yml` runs on every pull request: `npm install`, `eslint --fix`, `prettier --write`, then it
  commits and pushes any fixes to the PR branch. It does not fail on type errors and does not run tests.
- Run the tests locally before pushing, one file at a time:
  `node -r ts-node/register/transpile-only --test tests/<name>.test.ts`. `npx tsc --noEmit` type-checks.
- A husky pre-commit hook runs lint-staged (Prettier and ESLint on staged files).

## CD

### API (Cloud Build to Cloud Run)

The Cloud Build trigger `helphive-backend-gcloud-continous-deployment` (global) runs on every push to `main`, except
when every changed file matches its `ignoredFiles`: `edge/**`, `**/*.md` and `docs/**`. Its inline build config:

1. **Build:** `docker build --no-cache` with the `Dockerfile` (`node:22.12.0-alpine`, `npm ci`, `npm run build`, then
   `npm prune --omit=dev`). `npm ci` fails if `package-lock.json` is out of date, so update the lockfile with npm 10.9
   (Node 22.12) when dependencies change.
2. **Push** the image, tagged with the commit SHA, to Artifact Registry.
3. **Deploy:** `gcloud run services update helphive-backend` with the new image, labelled with the commit and build,
   and the `/readyz` startup probe.
4. **Prune:** delete every image of the package.

After a deploy, poll `https://api.helphive.himaiz.com/readyz` until it answers 200 with `"database":"ok"`.

**Manual on purpose:**

- **Environment variables** are changed with `gcloud run services update --update-env-vars`. Because images are
  pruned, that command reports "Image not found", but the new value is saved in the service template; run the trigger
  for `main` afterwards and the rebuilt revision picks it up.
- **Secrets** are changed by adding a version to `helphive-secrets`, destroying the old one, then running the trigger.

### API edge (Workers Builds)

Cloudflare Workers Builds deploys the Worker `helphive-api-edge` from this repo:

| Setting         | Value                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch          | `main` (preview builds off)                                                                                                                        |
| Root directory  | `/edge/api`                                                                                                                                        |
| Watch paths     | `edge/api/*`                                                                                                                                       |
| Build command   | none                                                                                                                                               |
| Deploy command  | `npx -y wrangler@4 deploy` (pinned to wrangler 4)                                                                                                  |
| Build variables | `SKIP_DEPENDENCY_INSTALL=1`: `edge/api` has no `package.json`, and without it the build image would run `npm ci` against this repo's root lockfile |
| Build token     | the account's shared "Workers Builds" token for the `himaiz.com` sites                                                                             |

The Worker's secret `ORIGIN_AUTH` is set once by hand (`npx wrangler@4 secret put ORIGIN_AUTH` from `edge/api`) and
survives deploys. Its plain variable `ORIGIN` (the Cloud Run URL) is in `edge/api/wrangler.toml`.

## Rollback

- **API:** old images are deleted, so an old revision can't start again. Roll back by reverting the commit on `main`
  (the trigger rebuilds), or rebuild the current `main` with `gcloud builds triggers run <trigger> --branch=main
--project helphive` (about 5 minutes). Never use `gcloud run services update-traffic --to-revisions <old>`: the old
  revision can't pull its image, and traffic stays pinned to it until `--to-latest`. A deploy whose `/readyz` never
  passes fails on its own and the running revision keeps serving.
- **API edge:** from `edge/api`, `npx wrangler@4 rollback` (or the Worker's Deployments tab), or revert the commit.

## Cloudflare

- **Shared zone.** HelpHive sits behind the `himaiz.com` zone: Full (strict) TLS, the Cloudflare Free Managed
  Ruleset, and custom rules that block scanner paths (for example `/.env`, `/.git`, `wp-*`, `*.php`) and unused HTTP
  methods. The zone's settings, WAF rules and rate limit are shared by every project and managed centrally in the
  private repo `maiznadeem/OracleVMOps` (`cloudflare/`). Never change them from a project; ask there.
- **`api.helphive` skips the browser checks** (Browser Integrity Check and Security Level). Its callers are machines,
  not browsers: the Android app, Stripe, CometChat and Cloud Tasks webhooks, and the provider WebSocket. They can't
  solve a browser challenge. The scanner-path and method blocks still apply to it.
- **Origin lock, Pattern A (API).** The edge Worker strips any copies the visitor sent of the headers below, then
  sets `X-Origin-Auth` (the `ORIGIN_AUTH` secret), `X-Client-IP` (from `CF-Connecting-IP`), `X-Forwarded-Host` and
  `X-Forwarded-Proto`, and forwards with `redirect: "manual"`. It builds the target from the `ORIGIN` URL and only
  copies the path and query, so a crafted path can't send the secret elsewhere. In the API, `lib/originAuth.ts` runs
  first: with `ORIGIN_AUTH_MODE=enforce` (a plain Cloud Run variable; `off` disables it) any request without the right
  secret gets 403, including WebSocket upgrades. It fails closed: enforcing without `ORIGIN_AUTH` (missing or
  blank) makes the server refuse to start, so a dropped secret can't reopen the direct URL; the new revision never
  becomes ready and the previous one keeps serving. Only the Cloud Run probes `/readyz`, `/healthz` and `/livez` are
  exempt. The direct `*.run.app` URL therefore answers 403. `req.ip` and the rate limiters use `X-Client-IP` only
  when the secret is valid.
- **WebSocket.** The provider socket goes through the edge Worker. The server pings every 30 seconds, because
  Cloudflare closes sockets idle for 100 seconds.
- **Pattern B (website and admin).** Workers static assets with headers, including the Content Security Policy, in
  each repo's `public/_headers`. `workers_dev` and preview URLs are off.
- **CORS:** deployed environments allow only `https://helphive.himaiz.com`, `https://admin.helphive.himaiz.com` and
  `https://api.helphive.himaiz.com` (`config/allowedOrigins.ts`). Local origins work only when `NODE_ENV=development`.
  Requests without an Origin (the app, webhooks, Cloud Tasks) aren't browser calls and pass.

## Logging

Both the API and the edge Worker follow the shared logging standard (`LOGGING.md` in the private repo
`maiznadeem/OracleVMOps`): one JSON object per line on stdout with `time`, `level`, `app` (`helphive`), `part`
(`api` or `edge`), `event`, `ray` and `msg`. The API adds `severity` and the trace fields Cloud Logging reads.

- **API (`lib/logger.ts`):** every call is `log.<level>(event, msg, ...)` with a fixed snake_case event per call site
  (`login_failed`, `stripe_webhook_signature_invalid`, `exception` for unexpected errors, `startup`, `db_connected`).
  Each finished request writes one `request` line with `method`, the matched `route` pattern (never the raw URL or
  query), `status`, `ms` and the user or admin id. 5xx and exceptions log at error; Cloud Run probes, CORS preflights
  and direct calls refused by the origin check (`origin_refused`) log at debug. The provider WebSocket logs
  `ws_connected` and `ws_disconnected` with the user id, never message contents. `LOG_LEVEL` (default `info`) sets the
  lowest level written.
- **Edge (`edge/api/index.js`):** one `request` line per call with the first path segment as `route` (`/auth/*`), or
  `exception` when the origin is unreachable. Workers Logs keep only that line: Cloudflare's own invocation logs are
  off and query strings are redacted (`wrangler.toml`).
- **One id across both:** the edge forwards the visitor's `CF-Ray` as `X-CF-Ray` (after deleting any the visitor
  sent), because Cloudflare gives the Worker's own call to Cloud Run a new `CF-Ray`. The API logs `X-CF-Ray` as `ray`,
  falling back to `CF-Ray`. Filter on one ray to see a request at the edge and at the API.
- **Never logged:** request or response bodies, cookies, tokens, passwords, emails (masked if they slip into a
  message) or phone numbers. Errors keep their name, code and stack.
- The admin console's log viewer reads these lines (`msg`, `event`, `ray`, request fields) as well as older ones.
- **Routes:** every router runs `markRouteBase` first, so error lines keep the mount path after Express resets
  `req.baseUrl`. A request no route handled (rejected by middleware such as the client-pass guard, or the catch-all 404) logs only its first path segment (`/auth/*`).
- **Cloud Run's platform request log is excluded** from the project's `_Default` sink (exclusion
  `cloud-run-request-urls`, `LOG_ID("run.googleapis.com/requests")`): it stores every full URL, query string included.
  The app's own `request` lines replace it.

## Secrets (names and places only)

- **`helphive-secrets`** in Secret Manager: one JSON object, given to Cloud Run as the env var `APP_SECRETS` and
  unpacked by `config/loadSecrets.ts` before anything else loads. Only the latest version is kept. Keys:
  `ACCESS_TOKEN_SECRET`, `ADMIN_ACCESS_TOKEN_SECRET`, `ADMIN_MFA_ENCRYPTION_KEY`, `ADMIN_REFRESH_TOKEN_SECRET`,
  `ATTEST_DEBUG_TOKENS`, `CHAT_TOKEN_ENCRYPTION_KEY`, `CLIENT_PASS_SECRET`, `COMETCHAT_REST_API_KEY`,
  `COMETCHAT_WEBHOOK_PASSWORD`, `COMETCHAT_WEBHOOK_USERNAME`, `DATABASE_URI`, `EMAIL_VERIFICATION_SECRET`,
  `GOOGLE_CLOUD_TASKS_SECRET`, `GOOGLE_MAPS_SERVER_API_KEY`, `ONE_SIGNAL_REST_API_KEY`, `ORIGIN_AUTH`,
  `REFRESH_TOKEN_SECRET`, `RESEND_API_KEY`, `STRIPE_CONNECTED_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`.
- **Plain Cloud Run variables** (not secret): `NODE_ENV`, `CLIENT_ATTEST_MODE`, `ORIGIN_AUTH_MODE`,
  `RECAPTCHA_SITE_KEY`, `GOOGLE_CLOUD_PROJECT`, `ONE_SIGNAL_APP_ID`, `RESEND_AUDIENCE_ID`, `COMETCHAT_APP_ID`,
  `COMETCHAT_REGION`, `ADMIN_CONSOLE_ORIGINS`, `ADMIN_ACCESS_TOKEN_TTL`. Every variable the server reads is listed,
  with notes, in `.env.example`.
- **Cloudflare:** the Worker secret `ORIGIN_AUTH` on `helphive-api-edge` (same value as in `helphive-secrets`). The
  website and admin Workers hold only public build variables.
- **GitHub:** no live workflow reads an Actions secret.
- **OneSignal's FCM key:** the `firebase-adminsdk-…` service-account key, uploaded to the OneSignal dashboard.
- **Android signing key:** kept by the maintainer outside every repo.

## Client attestation (bot protection)

The API only serves genuine app and website builds on its public routes:

- `POST /client-attest` checks a proof and returns a short-lived client pass. Clients send it as `X-Client-Pass`, bound
  to their `X-Device-Id`. With `CLIENT_ATTEST_MODE=enforce` (live), `/auth`, `/email` and `/public` answer 428
  `CLIENT_PASS_REQUIRED` without a valid pass; `log` only records failures and `off` turns the check off.
- **Android:** Play Integrity standard requests through the `helphive` Cloud project (there is no Play Console).
  APKs from GitHub Releases come back as `UNRECOGNIZED_VERSION`; the API accepts them when the signing certificate
  matches the release key and the device meets device integrity. Pass lifetime 1 hour
  (`CLIENT_PASS_TTL_ANDROID_SEC`). Free limit: 10,000 Play Integrity calls a day.
- **Website:** reCAPTCHA Enterprise score assessments (action `client_attest`), accepted at a score of 0.5 or more
  (`RECAPTCHA_MIN_SCORE`) and only for the hostname `helphive.himaiz.com`. Pass lifetime 12 hours
  (`CLIENT_PASS_TTL_WEB_SEC`). Free limit: 10,000 assessments a month.
- Emulator and local test builds can't pass Play Integrity; they use a debug token listed in `ATTEST_DEBUG_TOKENS`.
  A published APK never contains one.
- The admin console isn't covered: it has its own sign-in with two-step verification.

## Data

- **MongoDB Atlas**, database `Helphive-Dev` (the name dates from early development; it is the production database).
  The API connects as the database user `helphive-app`, which has `readWrite` on `Helphive-Dev` only. The connection
  string is `DATABASE_URI` in `helphive-secrets`.
- Files live in the Cloud Storage buckets listed above.

## Third-party services

Stripe (test mode; webhooks at `/webhook/stripe` and `/webhook/stripe/connected-payouts`), CometChat (chat; webhook at
`/webhook/cometchat` with basic auth), OneSignal (push notifications), Resend (email) and Google Maps Platform.
