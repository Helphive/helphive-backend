# HelpHive Backend

This folder contains the Node.js Express server for the HelpHive platform, handling all API requests, authentication, and database interactions.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file based on the `.env.example`:

```
PORT=
NODE_ENV=
DATABASE_URI=
ACCESS_TOKEN_SECRET=
REFRESH_TOKEN_SECRET=
EMAIL_VERIFICATION_SECRET=
GOOGLE_CLOUD_SERVICE_ACCOUNT_PRIVATE_KEY=
RESEND_API_KEY=
RESEND_AUDIENCE_ID=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
ONE_SIGNAL_APP_ID=
ONE_SIGNAL_REST_API_KEY=
```

### 3. Start the Server

```bash
npm start
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

### Linting and Formatting

Lint and format checks are automatically run on pull requests. Husky hooks ensure code quality on each commit using ESLint and Prettier.

### Scripts

- **Start**: `npm start` - Start the development server with `nodemon` and `ts-node`.
- **Build**: `npm build` - Compile TypeScript files to JavaScript.
- **Lint**: `npm lint` - Run ESLint to check for code issues.
- **Format**: `npm format` - Run Prettier to format code.
- **Email Preview**: `npm email` - Preview email templates during development.

## Notes

- This project is written in TypeScript.
- Uses MongoDB as the database, configured via `DATABASE_URI`.
- Google Cloud Storage is used for storing provider account information.

## License

This is a private repository. All rights reserved.
