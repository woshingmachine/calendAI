import { useState } from 'react'

declare global {
  interface Window {
    google: any
  }
}

function App() {
  const [request, setRequest] = useState('')
  const [result, setResult] = useState<any>(null)
  const [googleToken, setGoogleToken] = useState<string | null>(null)
  const GOOGLE_CLIENT_ID =
    "170841090382-kkhtvvvrv9h91h3dodf5b6cv0c1t3fl6.apps.googleusercontent.com"

  async function handleSchedule() {
    const response = await fetch('/api', {
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
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope:
              'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
            callback: async (response: any) => {
              setGoogleToken(response.access_token)
              const calendarResponse = await fetch(
                "https://www.googleapis.com/calendar/v3/users/me/calendarList",
                {
                  headers: {
                    Authorization: `Bearer ${response.access_token}`,
                  },
                }
              )

              const calendars = await calendarResponse.json()

              console.log("Google calendars:", calendars)

              const event = {
                summary: "CalendAI Test Event",
                description: "Created by CalendAI",
                start: {
                  dateTime: "2026-08-21T15:00:00+08:00",
                  timeZone: "Asia/Singapore",
                },
                end: {
                  dateTime: "2026-08-21T16:00:00+08:00",
                  timeZone: "Asia/Singapore",
                },
              }

              const eventResponse = await fetch(
                "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${response.access_token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(event),
                }
              )

              const createdEvent = await eventResponse.json()

              console.log("Created event:", createdEvent)
            },
          })

          client.requestAccessToken()
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
              if (!googleToken) {
                alert("Please connect Google Calendar first.")
                return
              }

              for (const date of result.dates) {
                const startDateTime = `${date}T${result.time}:00+08:00`

                const start = new Date(startDateTime)
                const end = new Date(start.getTime() + 60 * 60 * 1000)

                const event = {
                  summary: result.title,
                  start: {
                    dateTime: start.toISOString(),
                    timeZone: "Asia/Singapore",
                  },
                  end: {
                    dateTime: end.toISOString(),
                    timeZone: "Asia/Singapore",
                  },
                }

                const response = await fetch(
                  "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${googleToken}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(event),
                  }
                )

                const createdEvent = await response.json()
                console.log("Created:", createdEvent)
              }

              alert("Events added to Google Calendar!")
            }}
          >
            Confirm & Add to Calendar
          </button>
        </div>
      )}

    </main>
  )
}

export default App