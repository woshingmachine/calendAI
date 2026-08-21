import { useEffect, useState } from 'react'

const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8787'

function App() {
  const [request, setRequest] = useState('')
  const [result, setResult] = useState<any>(null)
  const [connected, setConnected] = useState(false)
  const [eventStatus, setEventStatus] = useState('')
  const [addingEvents, setAddingEvents] = useState(false)

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/auth/status`, { credentials: 'include' })
      .then((response) => response.json())
      .then((data: { connected?: boolean }) => setConnected(Boolean(data.connected)))
      .catch(() => setConnected(false))
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
                  body: JSON.stringify(result),
                })

                const data = await response.json() as { error?: string }
                if (!response.ok) {
                  setEventStatus(data.error ?? "Could not add events to Google Calendar.")
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