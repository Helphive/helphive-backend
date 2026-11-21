// Secrets: on Cloud Run, Secret Manager secret `helphive-secrets` (one JSON object of strings, only its latest version
// kept) arrives as the env var APP_SECRETS. It is unpacked here, before any other module reads process.env, and then
// removed. Locally APP_SECRETS is unset and index.ts loads .env as before. Imported first in index.ts.
if (process.env.APP_SECRETS) {
	Object.assign(process.env, JSON.parse(process.env.APP_SECRETS));
	delete process.env.APP_SECRETS;
}
