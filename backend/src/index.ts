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

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

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

function sessionExpiresAt() {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString()
}

function durationFromRequest(request: string) {
  const match = request.match(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i)
  if (!match) return undefined

  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  const durationMinutes = /^[hm]/.test(unit) && !/^min/.test(unit) && unit !== "m"
    ? value * 60
    : value
  return Number.isFinite(durationMinutes) && durationMinutes > 0 ? Math.round(durationMinutes) : undefined
}

async function getSession(request: Request, env: Env, extend = false) {
  const sessionId = getCookie(request, "session_id")
  if (!sessionId) return null
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?")
    .bind(sessionId, new Date().toISOString())
    .first<{ user_id: string }>()
  if (!row) return null

  if (extend) {
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(sessionExpiresAt(), sessionId)
      .run()
  }

  return { sessionId, userId: row.user_id }
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

async function getAccessTokenForSession(session: { userId: string }, env: Env) {
  const tokenRow = await env.DB.prepare("SELECT encrypted_refresh_token FROM oauth_tokens WHERE user_id = ?")
    .bind(session.userId)
    .first<{ encrypted_refresh_token: string }>()
  if (!tokenRow) return null
  const refreshToken = await decryptToken(tokenRow.encrypted_refresh_token, env.TOKEN_ENCRYPTION_KEY)
  return refreshAccessToken(refreshToken, env)
}

function buildGoogleEvent(title: string, date: string, time: string, durationMinutes: number) {
  const start = new Date(`${date}T${time}:00+08:00`)
  if (Number.isNaN(start.getTime())) return null
  return {
    summary: title,
    start: { dateTime: start.toISOString(), timeZone: "Asia/Singapore" },
    end: { dateTime: new Date(start.getTime() + durationMinutes * 60 * 1000).toISOString(), timeZone: "Asia/Singapore" },
  }
}

function normalizeTitle(value: string) {
  return value.toLowerCase().trim().replace(/s$/, "")
}

function titleMatches(query: string, summary: string) {
  if (!query) return true
  const q = normalizeTitle(query)
  const s = normalizeTitle(summary)
  return s.includes(q) || q.includes(s)
}

function eventDateLabel(start: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start
  const shifted = new Date(new Date(start).getTime() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
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
      const expiresAt = sessionExpiresAt()
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
      return Response.json({ connected: Boolean(await getSession(request, env, true)) }, { headers })
    }

    if (requestUrl.pathname === "/api/auth/logout" && request.method === "POST") {
      const sessionId = getCookie(request, "session_id")
      if (sessionId) {
        await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run()
      }

      const secure = requestUrl.protocol === "https:" ? "; Secure" : ""
      const sameSite = requestUrl.protocol === "https:" ? "None" : "Lax"
      const responseHeaders = new Headers(headers)
      responseHeaders.append("Set-Cookie", `session_id=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`)
      return Response.json({ success: true }, { headers: responseHeaders })
    }

    if (requestUrl.pathname === "/oauth/logout") {
      const sessionId = getCookie(request, "session_id")
      if (sessionId) {
        await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run()
      }

      const destination = new URL(frontendUrl)
      destination.searchParams.set("auth", "logged-out")
      const secure = requestUrl.protocol === "https:" ? "; Secure" : ""
      const sameSite = requestUrl.protocol === "https:" ? "None" : "Lax"
      return new Response(null, {
        status: 302,
        headers: {
          Location: destination.toString(),
          "Set-Cookie": `session_id=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`,
        },
      })
    }

    if (requestUrl.pathname === "/api/calendars" && request.method === "GET") {
      try {
        const session = await getSession(request, env, true)
        if (!session) return Response.json({ error: "Not connected" }, { status: 401, headers })
        const accessToken = await getAccessTokenForSession(session, env)
        if (!accessToken) return Response.json({ error: "Google account is not connected" }, { status: 401, headers })

        const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer", { headers: { Authorization: `Bearer ${accessToken}` } })
        if (!response.ok) return Response.json({ error: "Google rejected the calendar list request" }, { status: 502, headers })
        const data = (await response.json()) as { items?: Array<{ id: string; summary: string; primary?: boolean }> }
        const calendars = (data.items ?? []).map((item) => ({ id: item.id, summary: item.summary, primary: Boolean(item.primary) }))
        return Response.json({ calendars }, { headers })
      } catch (error) {
        console.error("Calendar list request failed", error)
        return Response.json({ error: "Calendar list request failed" }, { status: 502, headers })
      }
    }

    if (requestUrl.pathname === "/api/events" && request.method === "POST") {
      try {
        const session = await getSession(request, env, true)
        if (!session) return Response.json({ error: "Not connected" }, { status: 401, headers })
        const accessToken = await getAccessTokenForSession(session, env)
        if (!accessToken) return Response.json({ error: "Google account is not connected" }, { status: 401, headers })
        const body = (await request.json()) as {
          action?: string
          title?: string
          dates?: string[]
          dateRange?: { start: string; end: string } | null
          time?: string
          slots?: Array<{ date: string; time: string }>
          durationMinutes?: number
          calendarId?: string
          eventIds?: string[]
          updates?: Array<{ eventId: string; title: string; date: string; time: string; durationMinutes: number }>
        }
        const calendarId = body.calendarId?.trim() || "primary"

        if (body.action === "match") {
          if (!body.dates?.length && !body.dateRange) return Response.json({ error: "No dates to search" }, { status: 400, headers })
          const title = body.title?.trim() ?? ""

          const fetchWindowEvents = async (timeMinIso: string, timeMaxIso: string) => {
            const params = new URLSearchParams({ timeMin: timeMinIso, timeMax: timeMaxIso, singleEvents: "true", orderBy: "startTime", maxResults: "250" })
            const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } })
            if (!response.ok) return null
            const data = (await response.json()) as { items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }> }
            return (data.items ?? []).map((item) => ({
              id: item.id,
              summary: item.summary ?? "(untitled)",
              start: item.start?.dateTime ?? item.start?.date ?? "",
              end: item.end?.dateTime ?? item.end?.date ?? "",
            }))
          }

          if (body.dates?.length) {
            const matches = []
            for (const date of body.dates) {
              const timeMin = new Date(`${date}T00:00:00+08:00`)
              const timeMax = new Date(`${date}T23:59:59+08:00`)
              if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime())) {
                matches.push({ date, events: [], error: "Invalid date" })
                continue
              }
              const events = await fetchWindowEvents(timeMin.toISOString(), timeMax.toISOString())
              if (events === null) {
                matches.push({ date, events: [], error: "Google rejected the search request" })
                continue
              }
              matches.push({ date, events: events.filter((event) => titleMatches(title, event.summary)) })
            }
            return Response.json({ matches }, { headers })
          }

          const range = body.dateRange!
          const timeMin = new Date(`${range.start}T00:00:00+08:00`)
          const timeMax = new Date(`${range.end}T23:59:59+08:00`)
          const rangeLabel = `${range.start} to ${range.end}`
          if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime())) {
            return Response.json({ matches: [{ date: rangeLabel, events: [], error: "Invalid date range" }] }, { headers })
          }
          const events = await fetchWindowEvents(timeMin.toISOString(), timeMax.toISOString())
          if (events === null) {
            return Response.json({ matches: [{ date: rangeLabel, events: [], error: "Google rejected the search request" }] }, { headers })
          }
          const filtered = events.filter((event) => titleMatches(title, event.summary))
          if (filtered.length === 0) {
            return Response.json({ matches: [{ date: rangeLabel, events: [], error: "No matching events found in this range" }] }, { headers })
          }
          const grouped = new Map<string, typeof filtered>()
          for (const event of filtered) {
            const label = eventDateLabel(event.start)
            if (!grouped.has(label)) grouped.set(label, [])
            grouped.get(label)!.push(event)
          }
          const matches = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, dateEvents]) => ({ date, events: dateEvents }))
          return Response.json({ matches }, { headers })
        }

        if (body.action === "delete") {
          if (!body.eventIds?.length) return Response.json({ error: "No events to delete" }, { status: 400, headers })
          const results = []
          for (const eventId of body.eventIds) {
            const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } })
            const ok = response.ok || response.status === 404 || response.status === 410
            results.push({ id: eventId, ok, error: ok ? undefined : "Google rejected the delete request" })
          }
          return Response.json({ success: true, results }, { headers })
        }

        if (body.action === "update") {
          if (!body.updates?.length) return Response.json({ error: "No events to update" }, { status: 400, headers })
          const results = []
          for (const update of body.updates) {
            const event = buildGoogleEvent(update.title, update.date, update.time, update.durationMinutes)
            if (!event) {
              results.push({ id: update.eventId, ok: false, error: "Invalid event date or time" })
              continue
            }
            const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(update.eventId)}`, { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(event) })
            results.push({ id: update.eventId, ok: response.ok, error: response.ok ? undefined : "Google rejected the update request" })
          }
          return Response.json({ success: true, results }, { headers })
        }

        const slots = body.slots?.length ? body.slots : (body.time && body.dates?.length ? body.dates.map((date) => ({ date, time: body.time as string })) : [])
        if (!body.title || !slots.length) return Response.json({ error: "Invalid event" }, { status: 400, headers })
        const durationMinutes = Number.isFinite(body.durationMinutes) && (body.durationMinutes as number) > 0
          ? Math.round(body.durationMinutes as number)
          : 60

        const created = []
        for (const slot of slots) {
          const event = buildGoogleEvent(body.title, slot.date, slot.time, durationMinutes)
          if (!event) return Response.json({ error: "Invalid event date or time" }, { status: 400, headers })
          const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(event) })
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
      const userRequest = body.request ?? ""
      const today = new Date().toISOString().slice(0, 10)
      const systemPrompt = `Convert the user's request into ONLY valid JSON in this exact format: {"action":"create","title":"event title","slots":[{"date":"YYYY-MM-DD","time":"HH:MM"}],"dates":[],"dateRange":null,"time":null,"durationMinutes":60,"updates":null}. Today's date is ${today}, and the current year is 2026.
"action" is one of "create", "update", or "delete", based on what the user wants to do.
For "create": "slots" must contain one entry per event to add, each pairing one date with one time — this is how you express both "multiple dates at the same time" and "multiple times on the same date". For example "X on 1, 2, 7 and 8 August at 10am" produces four slots (one per date, all at 10:00), and "X today at 3pm, 6pm and 7pm" produces three slots (all on today's date, at 15:00/18:00/19:00). Never collapse multiple times into one slot or drop any requested time. Set "dates" to [], "dateRange" to null, and "time" to null for create; fill "title" and "durationMinutes" normally; set "updates" to null.
For "delete" or "update": set "slots" to []. title/time/durationMinutes describe the existing event(s) to find (time and durationMinutes are best-effort hints, not critical). For which day(s) to search:
  - If the user gives specific date(s) (e.g. "on 2 August", "next Monday"), set "dates" to that list of "YYYY-MM-DD" strings and leave "dateRange" null.
  - If the user refers to a period instead of specific dates (e.g. "all of August", "this week", "next 2 weeks", "in September"), set "dates" to an empty array [] and set "dateRange" to {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"} spanning that whole period inclusive, resolved relative to today's date.
For "delete", set "updates" to null. For "update", "updates" must be an object with only the fields the user wants changed, using null for fields that stay the same: {"title":null,"date":null,"time":null,"durationMinutes":null}.
Convert explicit durations to minutes: for example, '2 hour class' means durationMinutes 120, and '90 minutes' means durationMinutes 90. If the user gives an end time, calculate the duration from the start time. Only use 60 when no duration or end time is specified and the action is "create".`
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: "openai/gpt-oss-20b", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userRequest }] }),
      })
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content
      if (!content) return Response.json({ error: "AI parsing failed" }, { status: 502, headers })
      const parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/gi, "")) as Record<string, unknown>
      if (parsed.action === "create" || !parsed.action) {
        const explicitDuration = durationFromRequest(userRequest)
        if (explicitDuration !== undefined) parsed.durationMinutes = explicitDuration

        const isValidSlot = (slot: unknown): slot is { date: string; time: string } => {
          if (!slot || typeof slot !== "object") return false
          const { date, time } = slot as Record<string, unknown>
          return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof time === "string" && /^\d{2}:\d{2}$/.test(time)
        }
        let slots = Array.isArray(parsed.slots) ? parsed.slots.filter(isValidSlot) : []
        if (!slots.length) {
          const fallbackDates = Array.isArray(parsed.dates) ? parsed.dates.filter((d): d is string => typeof d === "string") : []
          const fallbackTime = typeof parsed.time === "string" ? parsed.time : null
          if (fallbackDates.length && fallbackTime) slots = fallbackDates.map((date) => ({ date, time: fallbackTime }))
        }
        if (!slots.length) {
          return Response.json({ error: "Could not understand the date/time for this event. Try rephrasing, e.g. \"Class on 27 August at 3pm and 5pm\"." }, { status: 422, headers })
        }
        parsed.slots = slots
      }
      return Response.json(parsed, { headers })
    }

    return Response.json({ message: "CalendAI backend is working!" }, { headers })
  },
}
