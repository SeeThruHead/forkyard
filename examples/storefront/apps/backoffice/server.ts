import { escape, html, listen, page, panel, readForm, redirect, table } from "@storefront/ui"
import { createServer } from "node:http"

const api = process.env.API_URL
const branch = process.env.FORKYARD_BRANCH ?? "local"

const get = async (path) => (await fetch(`${api}${path}`)).json()

const home = async (response) => {
  const [about, jobs] = await Promise.all([get("/api/info"), get("/api/jobs")])
  html(
    response,
    page({
      app: "backoffice",
      title: "backoffice",
      branch,
      body: `<h2>This worktree</h2>${panel([
        ["backoffice pid", process.pid],
        ["talks to api at", api],
        ["database", about.database],
        ["temporal server", about.temporal.address],
        ["temporal namespaces", about.temporal.namespaces.join(", ")],
        ["fulfillment namespace", process.env.TEMPORAL_NAMESPACE_FULFILLMENT]
      ])}
      <p><a href="${escape(process.env.TEMPORAL_UI_URL)}" target="_blank">Open this worktree's Temporal UI</a></p>
      <h2>Background jobs</h2>
      <form method="post" action="/jobs"><select name="kind"><option>recount inventory</option><option>send order receipts</option><option>rebuild search index</option></select><button>Queue</button></form>
      ${table(
        ["#", "Job", "Status", "Run by"],
        jobs.map((job) => [job.id, job.kind, job.status, job.done_by ?? ""])
      )}
      <p class="muted">The workers pick these up within a second. Refresh to see the status change.</p>`
    })
  )
}

listen(
  createServer(async (request, response) => {
    try {
      if (request.url === "/health") return html(response, "ok")
      if (request.method === "POST" && request.url === "/jobs") {
        const form = await readForm(request)
        await fetch(`${api}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) })
        return redirect(response, "/")
      }
      return await home(response)
    } catch (error) {
      console.error(error)
      response.writeHead(502, { "content-type": "text/plain" })
      response.end(`backoffice could not reach the api at ${api}: ${error.message}`)
    }
  }),
  "backoffice"
)
