import { ok, post, readJson, serve } from "@northwind/kit"

serve("fake-kyc", Number(process.env.PORT ?? 8190), {
  "GET /health": async () => ok({ ok: true }),
  "POST /send": async (request) => {
    const body = await readJson(request)
    return ok(await post(`${process.env.API_URL}/webhooks/kyc`, { status: String(body.status ?? "approved") }))
  }
})
