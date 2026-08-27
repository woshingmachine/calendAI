import { useEffect, useState } from 'react'

const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8787'

interface Calendar {
  id: string
  summary: string
  primary: boolean
}

interface ParsedUpdates {
  title: string | null
  date: string | null
  time: string | null
  durationMinutes: number | null
}

interface Slot {
  date: string
  time: string
}

interface ParsedResult {
  action?: 'create' | 'update' | 'delete'
  title: string
  slots?: Slot[]
  dates: string[]
  dateRange?: { start: string; end: string } | null
  time: string
  durationMinutes?: number
  updates?: ParsedUpdates | null
}

interface MatchedEvent {
  id: string
  summary: string
  start: string
  end: string
}

interface DateMatch {
  date: string
  events: MatchedEvent[]
  error?: string
}

interface ActionResult {
  id: string
  ok: boolean
  error?: string
}

function toSingaporeParts(iso: string) {
  const shifted = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000)
  return { date: shifted.toISOString().slice(0, 10), time: shifted.toISOString().slice(11, 16) }
}

function summarizeResults(results: ActionResult[], verb: string) {
  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) return `${results.length} event${results.length === 1 ? '' : 's'} ${verb}.`
  return `${results.length - failed.length} of ${results.length} ${verb} — ${failed.length} failed.`
}

function App() {
  const [request, setRequest] = useState('')
  const [result, setResult] = useState<ParsedResult | null>(null)
  const [connected, setConnected] = useState(false)
  const [eventStatus, setEventStatus] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [authStatus, setAuthStatus] = useState('')
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [selectedCalendarId, setSelectedCalendarId] = useState('primary')
  const [matches, setMatches] = useState<DateMatch[]>([])
  const [selectedEventIds, setSelectedEventIds] = useState<Record<string, boolean>>({})
  const [loadingMatches, setLoadingMatches] = useState(false)

  async function refreshAuthStatus() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/status`, { credentials: 'include' })
      const data = await response.json() as { connected?: boolean }
      setConnected(Boolean(data.connected))
      if (data.connected) await refreshCalendars()
    } catch {
      setConnected(false)
    }
  }

  async function refreshCalendars() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/calendars`, { credentials: 'include' })
      if (!response.ok) return
      const data = await response.json() as { calendars?: Calendar[] }
      const list = data.calendars ?? []
      setCalendars(list)
      const primary = list.find((calendar) => calendar.primary)
      setSelectedCalendarId(primary?.id ?? list[0]?.id ?? 'primary')
    } catch {
      setCalendars([])
    }
  }

  useEffect(() => {
    refreshAuthStatus()
  }, [])

  async function loadMatches(parsed: ParsedResult) {
    setLoadingMatches(true)
    setMatches([])
    setSelectedEventIds({})
    try {
      const response = await fetch(`${BACKEND_URL}/api/events`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'match', title: parsed.title, dates: parsed.dates, dateRange: parsed.dateRange ?? null, calendarId: selectedCalendarId }),
      })
      const data = await response.json() as { matches?: DateMatch[]; error?: string }
      if (!response.ok || !data.matches) {
        setEventStatus(data.error ?? 'Could not search for matching events.')
        return
      }
      setMatches(data.matches)
      const defaults: Record<string, boolean> = {}
      for (const group of data.matches) {
        if (group.events.length === 1) defaults[group.events[0].id] = true
      }
      setSelectedEventIds(defaults)
    } catch {
      setEventStatus('Could not reach the calendar backend.')
    } finally {
      setLoadingMatches(false)
    }
  }

  async function handleSchedule() {
    setResult(null)
    setMatches([])
    setSelectedEventIds({})
    setEventStatus('')
    const response = await fetch(`${BACKEND_URL}/api/parse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ request }),
    })

    const parsed = await response.json() as ParsedResult
    setResult(parsed)
    if (parsed.action === 'update' || parsed.action === 'delete') {
      await loadMatches(parsed)
    }
  }

  async function handleConfirm() {
    if (!result) return
    if (!connected) {
      setEventStatus('Please connect Google Calendar first.')
      return
    }

    const action = result.action ?? 'create'
    setSubmitting(true)
    setEventStatus(action === 'delete' ? 'Deleting events...' : action === 'update' ? 'Updating events...' : 'Adding events...')

    try {
      if (action === 'create') {
        const response = await fetch(`${BACKEND_URL}/api/events`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...result, calendarId: selectedCalendarId }),
        })

        let data: { error?: string } | null = null
        try {
          data = await response.json() as { error?: string }
        } catch {
          data = null
        }

        if (!response.ok) {
          setEventStatus(data?.error ?? `Calendar request failed (HTTP ${response.status}).`)
          return
        }
        setEventStatus('Events added to Google Calendar!')
        return
      }

      const selectedIds = Object.entries(selectedEventIds).filter(([, checked]) => checked).map(([id]) => id)
      if (selectedIds.length === 0) {
        setEventStatus('Select at least one event first.')
        return
      }

      if (action === 'delete') {
        const response = await fetch(`${BACKEND_URL}/api/events`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', calendarId: selectedCalendarId, eventIds: selectedIds }),
        })
        const data = await response.json() as { results?: ActionResult[]; error?: string }
        if (!response.ok || !data.results) {
          setEventStatus(data.error ?? `Calendar request failed (HTTP ${response.status}).`)
          return
        }
        setEventStatus(summarizeResults(data.results, 'deleted'))
        return
      }

      const eventsById = new Map(matches.flatMap((group) => group.events).map((event) => [event.id, event]))
      const updates = selectedIds.map((eventId) => {
        const event = eventsById.get(eventId)!
        const original = toSingaporeParts(event.start)
        const originalDuration = Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000)
        return {
          eventId,
          title: result.updates?.title ?? event.summary,
          date: result.updates?.date ?? original.date,
          time: result.updates?.time ?? original.time,
          durationMinutes: result.updates?.durationMinutes ?? originalDuration,
        }
      })

      const response = await fetch(`${BACKEND_URL}/api/events`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', calendarId: selectedCalendarId, updates }),
      })
      const data = await response.json() as { results?: ActionResult[]; error?: string }
      if (!response.ok || !data.results) {
        setEventStatus(data.error ?? `Calendar request failed (HTTP ${response.status}).`)
        return
      }
      setEventStatus(summarizeResults(data.results, 'updated'))
    } catch {
      setEventStatus('Could not reach the calendar backend.')
    } finally {
      setSubmitting(false)
    }
  }

  const action = result?.action ?? 'create'

  return (
    <main>
      <h1>CalendAI</h1>

      <button
        onClick={() => {
          window.location.href = `${BACKEND_URL}/oauth/start`
        }}
      >
        Connect Google Calendar
      </button>
      <button
        onClick={() => {
          setAuthStatus('Logging out...')
          setConnected(false)
          setResult(null)
          setEventStatus('')
          window.location.href = `${BACKEND_URL}/oauth/logout`
        }}
      >
        Log Out
      </button>
      {authStatus && <p role="status">{authStatus}</p>}
      <p>Connection status: {connected ? 'Connected' : 'Not connected'}</p>

      {connected && calendars.length > 0 && (
        <p>
          <label htmlFor="calendar-select">Add events to: </label>
          <select
            id="calendar-select"
            value={selectedCalendarId}
            onChange={(e) => setSelectedCalendarId(e.target.value)}
          >
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.summary}
                {calendar.primary ? ' (primary)' : ''}
              </option>
            ))}
          </select>
        </p>
      )}

      <p>What would you like to schedule, cancel, or change?</p>

      <textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="e.g. CS2040S on 1, 2, 7 and 8 August at 10am&#10;e.g. Cancel CS2040S on 2 August&#10;e.g. Move team sync tomorrow to 3pm"
        rows={4}
      />

      <br />

      <button onClick={handleSchedule}>
        Submit
      </button>

      {result && (action === 'create') && (
        <div>
          <h2>Event preview</h2>
          <p>Title: {result.title}</p>
          <ul>
            {(result.slots?.length ? result.slots : result.dates.map((date) => ({ date, time: result.time }))).map((slot) => (
              <li key={`${slot.date}-${slot.time}`}>{slot.date} at {slot.time}</li>
            ))}
          </ul>
          <p>Duration: {Number.isFinite(result.durationMinutes) && (result.durationMinutes as number) > 0 ? result.durationMinutes : 60} minutes</p>
          <button onClick={handleConfirm} disabled={submitting}>
            Confirm & Add to Calendar
          </button>
          {eventStatus && <p role="status">{eventStatus}</p>}
        </div>
      )}

      {result && (action === 'update' || action === 'delete') && (
        <div>
          <h2>{action === 'delete' ? 'Events to delete' : 'Events to update'}</h2>
          <p>
            Looking for: {result.title || '(any title)'}
            {result.dateRange
              ? ` between ${result.dateRange.start} and ${result.dateRange.end}`
              : result.dates?.length ? ` on ${result.dates.join(', ')}` : ''}
          </p>
          {action === 'update' && result.updates && (
            <p>
              Changes:{' '}
              {[
                result.updates.title && `title → ${result.updates.title}`,
                result.updates.date && `date → ${result.updates.date}`,
                result.updates.time && `time → ${result.updates.time}`,
                result.updates.durationMinutes && `duration → ${result.updates.durationMinutes} minutes`,
              ].filter(Boolean).join(', ') || 'none detected'}
            </p>
          )}

          {loadingMatches && <p role="status">Searching for matching events...</p>}

          {!loadingMatches && matches.map((group) => (
            <div key={group.date}>
              <strong>{group.date}</strong>
              {group.error && <p role="status">{group.error}</p>}
              {!group.error && group.events.length === 0 && <p>No matching event found.</p>}
              {group.events.map((event) => (
                <label key={event.id} style={{ display: 'block' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(selectedEventIds[event.id])}
                    onChange={(e) => setSelectedEventIds((prev) => ({ ...prev, [event.id]: e.target.checked }))}
                  />
                  {' '}{event.summary} ({toSingaporeParts(event.start).date} {toSingaporeParts(event.start).time})
                </label>
              ))}
            </div>
          ))}

          <button onClick={handleConfirm} disabled={submitting || loadingMatches}>
            {action === 'delete' ? 'Confirm & Delete' : 'Confirm & Update'}
          </button>
          {eventStatus && <p role="status">{eventStatus}</p>}
        </div>
      )}

    </main>
  )
}

export default App
