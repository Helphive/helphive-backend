# HelpHive Backend

This folder contains the Node.js Express server for the HelpHive platform, handling all API requests, authentication, and database interactions.

## Setup

### 1. Install Dependencies

```bash
yarn install
```

### 2. Environment Variables

Create a `.env` file based on the `.env.example`:

```
PORT=
CLIENT_BASE_URL=
DATABASE_URI=
ACCESS_TOKEN_SECRET=
REFRESH_TOKEN_SECRET=
EMAIL_VERIFICATION_SECRET=
RESEND_API_KEY=
RESEND_AUDIENCE_ID=
VERIFICATION_EMAIL=
PROVIDER_ACCOUNT_BUCKET=
GOOGLE_CLOUD_STORAGE_SERVICE_ACCOUNT=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

### 3. Start the Server

```bash
yarn start
```

### 4. Build the Project

```bash
yarn build
```

### 5. Useful Commands

- **Email Preview**: Preview email templates during development:
    ```bash
    yarn email
    ```

## Development

### Linting and Formatting

Lint and format checks are automatically run on pull requests. Husky hooks ensure code quality on each commit using ESLint and Prettier.

### Scripts

- **Start**: `yarn start` - Start the development server with `nodemon` and `ts-node`.
- **Build**: `yarn build` - Compile TypeScript files to JavaScript.
- **Lint**: `yarn lint` - Run ESLint to check for code issues.
- **Format**: `yarn format` - Run Prettier to format code.
- **Email Preview**: `yarn email` - Preview email templates during development.

## Notes

- This project is written in TypeScript.
- Uses MongoDB as the database, configured via `DATABASE_URI`.
- Google Cloud Storage is used for storing provider account information.

## License

This is a private repository. All rights reserved.
