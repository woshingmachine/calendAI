import { useState } from 'react'

function App() {
  const [request, setRequest] = useState('')
  const [result, setResult] = useState<any>(null)

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
      <button onClick={() => console.log("Google login clicked")}>
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
          <button onClick={() => console.log("Confirmed:", result)}>
            Confirm & Add to Calendar
          </button>
        </div>
      )}

    </main>
  )
}

export default App