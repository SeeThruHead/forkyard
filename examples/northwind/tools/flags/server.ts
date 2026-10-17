import { ok, readJson, serve } from "@northwind/kit"

const flags = new Map<string, boolean>([
  ["new-checkout", false],
  ["gift-cards", false],
  ["dark-mode", true]
])

serve("flags", Number(process.env.FLAGS_PORT ?? 4416), {
  "GET /health": async () => ok({ ok: true }),
  "GET /flags": async () => ok(Object.fromEntries(flags)),
  "PUT /flags/:key": async (request, params) => {
    flags.set(params.key!, Boolean((await readJson(request)).value))
    return ok(Object.fromEntries(flags))
  }
})
