import { ok, readJson, serve } from "@northwind/kit"

const lines: Array<string> = []

serve("log-viewer", Number(process.env.LOG_VIEWER_PORT ?? 4419), {
  "GET /health": async () => ok({ ok: true }),
  "POST /logs": async (request) => {
    lines.push(JSON.stringify(await readJson(request)))
    return ok({ ok: true })
  },
  "GET /": async () => ({ status: 200, headers: { "content-type": "text/html" }, body: `<pre>${lines.slice(-200).join("\n")}</pre>` })
})
