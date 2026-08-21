# calendAI

CalendAI turns natural-language requests into Google Calendar events. The React frontend sends requests to a Cloudflare Worker, which uses Groq to parse them and calls Google Calendar on behalf of the authenticated user.

## Architecture

- `frontend/`: React, TypeScript, and Vite application.
- `backend/`: Cloudflare Worker running Wrangler.
- Cloudflare D1: stores users, encrypted Google refresh tokens, and sessions.
- Google OAuth: authenticates the user and grants Calendar access.
- Groq: parses natural-language calendar requests into validated event data.

Google access and refresh tokens are never stored in the frontend. Refresh tokens are encrypted with AES-GCM before being stored in D1. The frontend receives only an HttpOnly session cookie.

## Prerequisites

- Node.js and npm.
- A Google Cloud project with the Google Calendar API enabled.
- A Google OAuth 2.0 Web application client.
- A Groq API key.
- A Cloudflare account if using the remote D1 database or deploying the Worker.

## Local Setup

Install dependencies:

```bash
cd backend
npm install

cd ../frontend
npm install
```

Create `backend/.dev.vars`. This file is ignored by Git:

```env
GROQ_API_KEY=your_groq_api_key
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
TOKEN_ENCRYPTION_KEY=your_base64_32_byte_key
GOOGLE_REDIRECT_URI=http://localhost:8787/oauth/callback
FRONTEND_URL=http://localhost:5173
```

Generate an encryption key with:

```bash
openssl rand -base64 32
```

Keep the same `TOKEN_ENCRYPTION_KEY` for the lifetime of the stored tokens. Changing it makes existing encrypted refresh tokens unreadable.

## Google OAuth Configuration

In Google Cloud Console, add this authorized redirect URI for local development:

```text
http://localhost:8787/oauth/callback
```

When using a forwarded Codespaces port, use the public backend URL instead, for example:

```text
https://YOUR-CODESPACE-8787.app.github.dev/oauth/callback
```

The URL must match `GOOGLE_REDIRECT_URI` exactly, including protocol, port, path, and trailing slash.

## D1 Database

The D1 binding is configured in `backend/wrangler.jsonc`. To create a new remote database:

```bash
cd backend
npx wrangler login
npx wrangler d1 create calendai-db
```

Copy the returned database ID into `backend/wrangler.jsonc` as `database_id`, then apply the migration:

```bash
npx wrangler d1 migrations apply calendai-db --remote
```

For the local development database, use:

```bash
npx wrangler d1 migrations apply calendai-db --local
```

## Run Locally

Start the backend:

```bash
cd backend
npx wrangler dev --port 8787
```

In another terminal, start the frontend:

```bash
cd frontend
npm run dev -- --host 0.0.0.0 --port 5173
```

Open the frontend at `http://localhost:5173`. The OAuth flow starts at the backend and returns to the configured frontend URL.

## API Flow

1. `GET /oauth/start` begins Google OAuth with a short-lived state cookie.
2. `GET /oauth/callback` verifies state, exchanges the code, stores the encrypted refresh token, and creates a session.
3. `GET /api/auth/status` reports whether the session is connected.
4. `POST /api/parse` sends natural language to Groq and returns the event preview.
5. `POST /api/events` refreshes the Google access token and creates or deletes Calendar events.

The frontend uses `credentials: 'include'` for authenticated API requests. Do not move Google tokens into React state, local storage, or frontend environment variables.

## Validation

Build the frontend:

```bash
cd frontend
npm run build
```

Validate the Worker bundle without deploying:

```bash
cd backend
npx wrangler deploy --dry-run
```

## Security Notes

- Never commit `backend/.dev.vars`, `frontend/.env.local`, service-account files, or API keys.
- Store production secrets with Wrangler:

	```bash
	npx wrangler secret put GROQ_API_KEY
	npx wrangler secret put GOOGLE_CLIENT_SECRET
	npx wrangler secret put TOKEN_ENCRYPTION_KEY
	```

- Rotate any Google or Groq credential that has been exposed.
- Keep `TOKEN_ENCRYPTION_KEY` private and stable.
