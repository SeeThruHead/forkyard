import { escape, page, panel, table } from "@shortly/shared"

const api = process.env.API_URL!
const branch = process.env.FORKYARD_BRANCH ?? "local"

const home = async () => {
  const [about, links] = await Promise.all([
    fetch(`${api}/api/info`).then((response) => response.json()),
    fetch(`${api}/api/links`).then((response) => response.json())
  ])
  return page({
    app: "web",
    branch,
    body: `<h2>This worktree</h2>${panel([
      ["web pid", process.pid],
      ["talks to api at", api],
      ["database", about.database],
      ["redis (own server)", about.redis],
      ["link TTL (.env.local wins)", `${about.linkTtlDays} days`],
      ["analytics (not mapped)", process.env.ANALYTICS_URL]
    ])}
    <h2>Shorten a link</h2><form method="post" action="/links"><input name="target" placeholder="https://example.com/some/long/path" required><button>Shorten</button></form>
    <h2>Links</h2>${table(["Code", "Target", "Clicks", "Checked by worker"], links.map((link: Record<string, unknown>) => [link.code, link.target, link.clicks, link.checked_by ?? "waiting"]))}
    <p class="muted">Rendered by Bun; data from the api at <code>${escape(api)}</code>.</p>`
  })
}

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  routes: {
    "/health": new Response("ok"),
    "/links": {
      POST: async (request) => {
        const form = await request.formData()
        await fetch(`${api}/api/links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: form.get("target") }) })
        return Response.redirect("/", 303)
      }
    },
    "/": () => home()
  }
})

console.log(`web listening on ${process.env.PORT}, api at ${api}`)
