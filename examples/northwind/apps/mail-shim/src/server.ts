import { branch, ok, post, readJson, serve } from "@northwind/kit"

serve("mail-shim", Number(process.env.PORT ?? 8191), {
  "GET /health": async () => ok({ ok: true }),
  "POST /v3/:domain/messages": async (request, params) => {
    const message = await readJson(request)
    const sent = await post(`${process.env.MAILPIT_URL}/api/v1/send`, {
      From: { Email: `orders@${params.domain}` },
      To: [{ Email: message.to }],
      Subject: `[${branch}] ${message.subject}`,
      Text: message.text
    })
    return ok({ id: sent.ID, message: "Queued. Thank you." })
  }
})
