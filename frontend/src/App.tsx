import { useEffect, useState } from 'react'

const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8787'

interface Calendar {
  id: string
  summary: string
  primary: boolean
}

function App() {
  const [request, setRequest] = useState('')
  const [result, setResult] = useState<any>(null)
  const [connected, setConnected] = useState(false)
  const [eventStatus, setEventStatus] = useState('')
  const [addingEvents, setAddingEvents] = useState(false)
  const [authStatus, setAuthStatus] = useState('')
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [selectedCalendarId, setSelectedCalendarId] = useState('primary')

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

  async function handleSchedule() {
    const response = await fetch(`${BACKEND_URL}/api/parse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ request }),
    })

    const result = await response.json()
    setResult(result)
  }

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

      <p>What would you like to schedule?</p>

      <textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="e.g. CS2040S on 1, 2, 7 and 8 August at 10am"
        rows={4}
      />

      <br />

      <button onClick={handleSchedule}>
        Schedule
      </button>

      {result && (
        <div>
          <h2>Event preview</h2>
          <p>Title: {result.title}</p>
          <p>Dates: {result.dates.join(', ')}</p>
          <p>Time: {result.time}</p>
          <p>Duration: {Number.isFinite(result.durationMinutes) && result.durationMinutes > 0 ? result.durationMinutes : 60} minutes</p>
          <button
            onClick={async () => {
              if (!connected) {
                setEventStatus("Please connect Google Calendar first.")
                return
              }

              setAddingEvents(true)
              setEventStatus('Adding events...')
              try {
                const response = await fetch(`${BACKEND_URL}/api/events`, {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ ...result, calendarId: selectedCalendarId }),
                })

                let data: { error?: string } | null = null
                try {
                  data = await response.json() as { error?: string }
                } catch {
                  data = null
                }

                if (!response.ok) {
                  const message = data?.error ?? `Calendar request failed (HTTP ${response.status}).`
                  setEventStatus(message)
                  return
                }

                setEventStatus("Events added to Google Calendar!")
              } catch {
                setEventStatus("Could not reach the calendar backend.")
              } finally {
                setAddingEvents(false)
              }
            }}
            disabled={addingEvents}
          >
            Confirm & Add to Calendar
          </button>
          {eventStatus && <p role="status">{eventStatus}</p>}
        </div>
      )}

    </main>
  )
}

export default App