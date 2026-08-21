# calendAI

CalendAI lets you type natural-language plans and add them to Google Calendar. (https://calendai/pages/dev)

Example requests:

- CS2040S on 1, 2, 7 and 8 August at 10am
- Team sync tomorrow at 2pm for 30 minutes
- Workout every Monday at 7pm for 90 minutes

## Use the app

1. Open the app frontend.
2. Click Connect Google Calendar.
3. Complete Google sign-in and consent.
4. Enter your request.
5. Click Schedule to generate a preview.
6. Verify title, dates, time, and duration.
7. Click Confirm and Add to Calendar.

If successful, events are created in your Google Calendar.

## What to expect

- Connection status is shown in the UI.
- Logout is available from the UI.
- Sessions expire after 30 days of inactivity.
- Session expiry is rolling: active use keeps you logged in.
- Event duration is supported through durationMinutes.
  If no duration is detected, default is 60 minutes.

## Troubleshooting

If Connect Google Calendar works but adding events fails:

- Ensure VITE_BACKEND_URL points to your deployed Worker.
- Ensure FRONTEND_URL matches your deployed frontend URL.
- Ensure GOOGLE_REDIRECT_URI exactly matches your Worker callback URL.
- Check the app status message under Confirm and Add to Calendar.

If logout redirects to the wrong host:

- Verify FRONTEND_URL in Worker variables.

If login works in normal Chrome but not in incognito/private mode:

- Your browser may block cross-site cookies.
  This is expected with pages.dev and workers.dev cross-origin setups.

## Security and privacy

- Access and refresh tokens are never stored in frontend state.
- Refresh tokens are encrypted before storing in D1.
- Session cookies are HttpOnly.
- Do not commit backend/.dev.vars, frontend/.env.local, or any credentials.

If any secret was exposed, rotate it immediately.

## Project operator quick setup

This section is for maintainers deploying and operating the app.

### Frontend (Cloudflare Pages)

- Root directory: frontend
- Build command: npm run build
- Build output directory: dist
- Production variable:

```text
VITE_BACKEND_URL=https://your-worker.workers.dev
```

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

### Deploy backend

```bash
npx wrangler deploy
```

### Google OAuth redirect URI

Add this exact URI to the OAuth client:

```text
https://your-worker.workers.dev/oauth/callback
```
