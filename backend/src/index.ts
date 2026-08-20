export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") {
      const body = await request.json<{ request?: string }>()
      const text = body.request ?? ""

      return Response.json({
        message: `You said: ${text}`,
      })
    }

    return Response.json({
      message: "CalendAI backend is working!",
    })
  },
}