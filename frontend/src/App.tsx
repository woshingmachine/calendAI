import { useState } from 'react'

function App() {
  const [request, setRequest] = useState('')

  async function handleSchedule() {
    const response = await fetch('/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ request }),
    })

    const result = await response.json()
    console.log(result)
  }

  return (
    <main>
      <h1>CalendAI</h1>
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
    </main>
  )
}

export default App