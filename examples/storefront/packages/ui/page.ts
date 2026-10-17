const hue = (text) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7)

export const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const css = `
:root{--accent:#3730a3;--ink:#1f2328;--muted:#57606a;--line:#e5e7eb;--tint:#eef2ff}
*{box-sizing:border-box}body{margin:0;color:var(--ink);font:14px/1.55 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#fff}
header{background:#111827;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header strong{font-size:16px}header .app{color:#d1d5db}
.branch{padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px;color:#fff}
main{padding:18px 20px;max-width:1000px}h2{font-size:16px;margin:22px 0 8px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:#f9fafb;font-weight:600}code{font:12px ui-monospace,Menlo,monospace;background:#f3f4f6;padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}
.panel{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--tint);padding:10px 14px;margin:6px 0 14px}
.panel dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:0}.panel dt{color:var(--muted)}.panel dd{margin:0}
form{display:flex;gap:8px;margin:8px 0}input,select{flex:1;padding:7px 9px;border:1px solid #d1d5db;border-radius:4px;font:inherit}
button{background:var(--accent);color:#fff;border:0;border-radius:4px;padding:7px 14px;font:inherit;cursor:pointer}
.muted{color:var(--muted)}.empty{color:var(--muted);font-style:italic}
`

export const page = ({ app, title, branch, body }) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} (${escape(branch)})</title><style>${css}</style></head>
<body><header><strong>Storefront</strong><span class="app">${escape(app)}</span>
<span class="branch" style="background:hsl(${hue(branch)} 62% 34%)">${escape(branch)}</span></header>
<main>${body}</main></body></html>`

export const panel = (rows) =>
  `<div class="panel"><dl>${rows.map(([label, value]) => `<dt>${escape(label)}</dt><dd><code>${escape(value)}</code></dd>`).join("")}</dl></div>`

export const table = (columns, rows) =>
  rows.length === 0
    ? `<p class="empty">Nothing yet.</p>`
    : `<table><tr>${columns.map((column) => `<th>${escape(column)}</th>`).join("")}</tr>${rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`)
        .join("")}</table>`

export const readForm = async (request) => Object.fromEntries(new URLSearchParams(Buffer.concat(await request.toArray()).toString()))

export const readJson = async (request) => {
  const text = Buffer.concat(await request.toArray()).toString()
  return text ? JSON.parse(text) : {}
}

export const send = (response, status, type, body) => {
  response.writeHead(status, { "content-type": type })
  response.end(body)
}

export const json = (response, status, body) => send(response, status, "application/json", JSON.stringify(body, null, 2))

export const html = (response, body) => send(response, 200, "text/html; charset=utf-8", body)

export const redirect = (response, location) => {
  response.writeHead(303, { location })
  response.end()
}

const logRequests = (server) =>
  server.on("request", (request, response) => {
    const started = performance.now()
    response.on("finish", () => {
      if (request.url === "/health") return
      console.log(`${request.method} ${request.url} ${response.statusCode} ${Math.round(performance.now() - started)}ms`)
    })
  })

export const listen = (server, name) =>
  logRequests(server).listen(Number(process.env.PORT), "127.0.0.1", () =>
    console.log(
      `${name} listening on 127.0.0.1:${process.env.PORT} for worktree ${process.env.FORKYARD_WORKTREE ?? "(not under forkyard)"}`
    )
  )
