// Loads the secrets bundle before anything reads process.env: on Cloud Run, Secret Manager secret `helphive-backend-env`
// is mounted as a dotenv file at /secrets/app.env (SECRETS_FILE overrides the path). Plain env vars keep priority.
// Locally the file is absent and index.ts loads .env as before. Imported first in index.ts.
import fs from "fs";
import dotenv from "dotenv";

export const SECRETS_FILE = process.env.SECRETS_FILE || "/secrets/app.env";

if (fs.existsSync(SECRETS_FILE)) dotenv.config({ path: SECRETS_FILE });
