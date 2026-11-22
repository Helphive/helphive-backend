# HelpHive Backend

This repo contains the Node.js Express server for the HelpHive platform, handling all API requests, authentication, and database interactions.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Copy `.env.example` to `.env` and fill it in. It lists every variable the server reads, with notes. Set
`NODE_ENV=development` locally: only then does the API accept browser calls from localhost. In production, secrets come
from the `helphive-secrets` JSON secret (see [Deployment](#deployment)).

### 3. Start the Server

```bash
npm run dev
```

### 4. Build the Project

```bash
npm run build
```

### 5. Useful Commands

- **Email Preview**: Preview email templates during development:
    ```bash
    npm run email
    ```

## Development

### Linting, Formatting and Tests

A workflow on every pull request runs ESLint and Prettier and pushes their fixes to the PR branch; it does not run
tests or fail on type errors. Husky runs lint-staged on each commit. Before pushing, type-check with `npx tsc --noEmit`
and run the tests with `node -r ts-node/register/transpile-only --test tests/<name>.test.ts`.

### Scripts

- **Dev**: `npm run dev` - Start the development server with `ts-node-dev`, restarting on changes.
- **Start**: `npm start` - Compile, then run `dist/index.js`.
- **Build**: `npm run build` - Compile TypeScript files to JavaScript.
- **Lint**: `npm run lint` - Run ESLint to check for code issues.
- **Format**: `npm run format` - Run Prettier to format code.
- **Email Preview**: `npm run email` - Preview email templates during development.

## Deployment

Full details, checked against the live setup: [docs/infrastructure.md](docs/infrastructure.md). In short:

- **Hosting:** the API runs on Google Cloud Run (service `helphive-backend`, project `helphive`, `us-central1`) behind
  the Cloudflare Worker `helphive-api-edge` (`edge/api`), which serves `api.helphive.himaiz.com`. The direct Cloud Run
  URL refuses every request without the edge's secret (`ORIGIN_AUTH_MODE=enforce`), except the `/readyz`, `/healthz`
  and `/livez` probes.
- **CD:** every push to `main` builds the `Dockerfile` (`npm ci`) in Cloud Build and deploys it to Cloud Run with a
  `/readyz` startup probe. Pushes that change only `edge/**`, `**/*.md` or `docs/**` skip it. Changes under `edge/api`
  deploy the edge Worker through Cloudflare Workers Builds (`npx -y wrangler@4 deploy`, `SKIP_DEPENDENCY_INSTALL=1`).
- **Rollback:** revert the commit, or rebuild `main` with the trigger. Old images are deleted after each deploy, so
  older revisions can't be restarted.
- **Cloudflare:** the shared `himaiz.com` zone's WAF and settings are managed centrally in `maiznadeem/OracleVMOps`;
  `api.helphive` skips the browser checks because its callers are apps and webhooks.
- **Secrets:** one Secret Manager secret, `helphive-secrets` (JSON, env var `APP_SECRETS`), plus the edge Worker's
  `ORIGIN_AUTH`. The API itself uses no service-account key.
- **Data:** MongoDB Atlas database `Helphive-Dev`, used through the `helphive-app` user (`readWrite` on that database
  only); files in Cloud Storage.

## Notes

- This project is written in TypeScript.
- Uses MongoDB as the database, configured via `DATABASE_URI`.
- Google Cloud Storage holds profile pictures and provider documents.

## License

All rights reserved.
