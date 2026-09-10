# calendAI

CalendAI lets you type natural-language plans and add them to Google Calendar. (https://calendai.pages.dev)

## Features

- **Natural language scheduling** - Describe events in plain English
- **Event management** - Create, edit, and delete calendar events
- **Multi-date/time support** - Schedule multiple events at once (e.g., "Class on 1, 2, 7 August at 10am")
- **Dark mode** - Optimized for mobile with dark theme
- **PWA support** - Install as a standalone app on your phone
- **Multiple calendars** - Choose which calendar to add events to

## Example requests

- CS2040S on 1, 2, 7 and 8 August at 10am
- Team sync tomorrow at 2pm for 30 minutes
- Workout every Monday at 7pm for 90 minutes
- Cancel CS2040S on 2 August
- Move team sync tomorrow to 3pm

## Use the app

1. Open [calendai.pages.dev](https://calendai.pages.dev) on your phone or desktop.
2. Click **Connect Google Calendar**.
3. Complete Google sign-in and consent.
4. Enter your request in natural language.
5. Click **Submit** to parse the request.
6. Verify the preview (dates, time, duration).
7. Click **Confirm & Add to Calendar**.

For edit/delete actions, the app will show matching events for you to select.

## What to expect

- Connection status is shown in the UI.
- Logout is available from the UI.
- Sessions expire after 30 days of inactivity.
- Session expiry is rolling: active use keeps you logged in.
- Event duration defaults to 60 minutes if not specified.
- Events are added to your primary calendar by default.

## Tech stack

- **Frontend**: React, TypeScript, Vite, Cloudflare Pages
- **Backend**: Cloudflare Workers (TypeScript)
- **Database**: Cloudflare D1
- **AI**: Groq API (GPT-OSS-20b)

## Development

### Frontend

```bash
cd frontend
npm run dev
```

### Backend

```bash
cd backend
npx wrangler dev
```

## Deployment

The app is automatically deployed via Cloudflare Pages.

### Backend deploy

```bash
cd backend
npx wrangler deploy
```

## Security

- Access and refresh tokens are never stored in frontend state.
- Refresh tokens are encrypted before storing in D1.
- Session cookies are HttpOnly.
- Do not commit `backend/.dev.vars`, `frontend/.env.local`, or any credentials.
- If any secret is exposed, rotate it immediately.

## Project operator quick setup

### Frontend (Cloudflare Pages)

- Root directory: `frontend`
- Build command: `npm run build`
- Build output directory: `dist`
- Production variable: `VITE_BACKEND_URL=https://your-worker.workers.dev`

### Backend (Cloudflare Worker)

Required secrets:

```bash
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

Required variables:

```text
FRONTEND_URL=https://your-frontend.pages.dev
GOOGLE_REDIRECT_URI=https://your-worker.workers.dev/oauth/callback
```

### D1 migration

```bash
npx wrangler d1 migrations apply calendai-db --remote
```

### Google OAuth redirect URI

Add this exact URI to your OAuth client:

```
https://your-worker.workers.dev/oauth/callback
```
