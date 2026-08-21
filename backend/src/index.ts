/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database
  GROQ_API_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  TOKEN_ENCRYPTION_KEY: string
  FRONTEND_URL?: string
  GOOGLE_REDIRECT_URI?: string
}

interface GoogleTokens {
  access_token?: string
  refresh_token?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
}

function base64ToBytes(value: string) {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be Base64-encoded")
  }

  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

async function encryptionKey(value: string) {
  const keyBytes = base64ToBytes(value)
  if (keyBytes.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes")
  }

  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

async function encryptToken(token: string, keyValue: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(keyValue), encoder.encode(token))
  const result = new Uint8Array(iv.length + encrypted.byteLength)
  result.set(iv)
  result.set(new Uint8Array(encrypted), iv.length)
  return bytesToBase64(result)
}

async function decryptToken(value: string, keyValue: string) {
  const combined = base64ToBytes(value)
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: combined.slice(0, 12) }, await encryptionKey(keyValue), combined.slice(12))
  return decoder.decode(decrypted)
}

function getCookie(request: Request, name: string) {
  return request.headers.get("Cookie")?.match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1]
}

function corsHeaders(frontendUrl: string) {
  return {
    "Access-Control-Allow-Origin": frontendUrl,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  }
}

async function getSessionUserId(request: Request, env: Env) {
  const sessionId = getCookie(request, "session_id")
  if (!sessionId) return null
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?")
    .bind(sessionId, new Date().toISOString())
    .first<{ user_id: string }>()
  return row?.user_id ?? null
}

async function refreshAccessToken(refreshToken: string, env: Env) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  })
  if (!response.ok) throw new Error("Google access token refresh failed")
  const tokens = (await response.json()) as { access_token?: string }
  if (!tokens.access_token) throw new Error("Google returned no access token")
  return tokens.access_token
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url)
    const frontendUrl = env.FRONTEND_URL ?? "http://localhost:5173"
    const redirectUri = env.GOOGLE_REDIRECT_URI ?? `${requestUrl.origin}/oauth/callback`
    const headers = corsHeaders(frontendUrl)

    if (request.method === "OPTIONS") return new Response(null, { headers })

    if (requestUrl.pathname === "/oauth/start") {
      const state = crypto.randomUUID()
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
        access_type: "offline",
        prompt: "consent",
        state,
      })
      const secure = requestUrl.protocol === "https:" ? "; Secure" : ""
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
          "Set-Cookie": `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=600${secure}`,
        },
      })
    }

    if (requestUrl.pathname === "/oauth/callback") {
      const code = requestUrl.searchParams.get("code")
      const state = requestUrl.searchParams.get("state")
      if (!code || !state || state !== getCookie(request, "oauth_state")) {
        return Response.json({ error: "Invalid OAuth callback" }, { status: 400 })
      }

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      })
      if (!tokenResponse.ok) return Response.json({ error: "Google token exchange failed" }, { status: 502 })
      const tokens = (await tokenResponse.json()) as GoogleTokens
      if (!tokens.access_token || !tokens.refresh_token) return Response.json({ error: "Google did not return required tokens" }, { status: 502 })

      const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } })
      const profile = (await profileResponse.json()) as { sub?: string }
      if (!profile.sub) return Response.json({ error: "Google user lookup failed" }, { status: 502 })

      const now = new Date().toISOString()
      await env.DB.prepare("INSERT INTO users (id, google_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(google_user_id) DO NOTHING")
        .bind(crypto.randomUUID(), profile.sub, now).run()
      const user = await env.DB.prepare("SELECT id FROM users WHERE google_user_id = ?").bind(profile.sub).first<{ id: string }>()
      if (!user) return Response.json({ error: "Could not save user" }, { status: 500 })

      const encryptedToken = await encryptToken(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY)
      await env.DB.prepare("INSERT INTO oauth_tokens (user_id, encrypted_refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_refresh_token = excluded.encrypted_refresh_token, updated_at = excluded.updated_at")
        .bind(user.id, encryptedToken, now, now).run()

      const sessionId = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(sessionId, user.id, expiresAt).run()

      const destination = new URL(frontendUrl)
      destination.searchParams.set("auth", "success")
      const secure = requestUrl.protocol === "https:" ? "; Secure" : ""
      const sameSite = requestUrl.protocol === "https:" ? "None" : "Lax"
      const responseHeaders = new Headers({ Location: destination.toString() })
      responseHeaders.append("Set-Cookie", `session_id=${sessionId}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=2592000${secure}`)
      responseHeaders.append("Set-Cookie", `oauth_state=; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=0${secure}`)
      return new Response(null, { status: 302, headers: responseHeaders })
    }

    if (requestUrl.pathname === "/api/auth/status") {
      return Response.json({ connected: Boolean(await getSessionUserId(request, env)) }, { headers })
    }

    if (requestUrl.pathname === "/api/events" && request.method === "POST") {
      try {
        const userId = await getSessionUserId(request, env)
        if (!userId) return Response.json({ error: "Not connected" }, { status: 401, headers })
        const tokenRow = await env.DB.prepare("SELECT encrypted_refresh_token FROM oauth_tokens WHERE user_id = ?").bind(userId).first<{ encrypted_refresh_token: string }>()
        if (!tokenRow) return Response.json({ error: "Google account is not connected" }, { status: 401, headers })
        const refreshToken = await decryptToken(tokenRow.encrypted_refresh_token, env.TOKEN_ENCRYPTION_KEY)
        const accessToken = await refreshAccessToken(refreshToken, env)
        const body = (await request.json()) as { action?: string; title?: string; dates?: string[]; time?: string; eventId?: string }

        if (body.action === "delete" && body.eventId) {
          const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(body.eventId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } })
          if (!response.ok) return Response.json({ error: "Google rejected the delete request" }, { status: 502, headers })
          return Response.json({ success: true }, { headers })
        }
        if (!body.title || !body.time || !body.dates?.length) return Response.json({ error: "Invalid event" }, { status: 400, headers })

        const created = []
        for (const date of body.dates) {
          const start = new Date(`${date}T${body.time}:00+08:00`)
          if (Number.isNaN(start.getTime())) return Response.json({ error: "Invalid event date or time" }, { status: 400, headers })
          const event = { summary: body.title, start: { dateTime: start.toISOString(), timeZone: "Asia/Singapore" }, end: { dateTime: new Date(start.getTime() + 60 * 60 * 1000).toISOString(), timeZone: "Asia/Singapore" } }
          const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(event) })
          if (!response.ok) return Response.json({ error: "Google rejected the event request" }, { status: 502, headers })
          created.push(await response.json())
        }
        return Response.json({ success: true, events: created }, { headers })
      } catch (error) {
        console.error("Calendar event request failed", error)
        return Response.json({ error: "Calendar request failed" }, { status: 502, headers })
      }
    }

    if (requestUrl.pathname === "/api/parse" && request.method === "POST") {
      const body = (await request.json()) as { request?: string }
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: "openai/gpt-oss-20b", messages: [{ role: "system", content: "Convert the user's request into ONLY valid JSON in this format: {\"title\":\"event title\",\"dates\":[\"YYYY-MM-DD\"],\"time\":\"HH:MM\"}. The current year is 2026." }, { role: "user", content: body.request ?? "" }] }),
      })
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content
      if (!content) return Response.json({ error: "AI parsing failed" }, { status: 502, headers })
      return Response.json(JSON.parse(content), { headers })
    }

    return Response.json({ message: "CalendAI backend is working!" }, { headers })
  },
}
