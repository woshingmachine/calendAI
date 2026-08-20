export default {
  async fetch(
    request: Request,
    env: { GROQ_API_KEY: string }
  ): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({
        message: "CalendAI backend is working!",
      })
    }

    const body = await request.json<{ request?: string }>()
    const text = body.request ?? ""

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          messages: [
            {
              role: "system",
              content: `You are a calendar assistant.
              Convert the user's request into JSON with exactly this format:
              {
              "title": "event title",
              "dates": ["YYYY-MM-DD"],
              "time": "HH:MM"
              }
              Return ONLY valid JSON. No explanations, no markdown.
              The current year is 2026.`,
            },
            {
              role: "user",
              content: text,
            },
          ],
        }),
      }
    )

    const data = await response.json()

    const aiResponse = data.choices[0].message.content
    const event = JSON.parse(aiResponse)

    return Response.json(event)
  },
}