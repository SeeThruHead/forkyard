export const escape = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const hue = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 11)

export const page = (options: { app: string; branch: string; body: string }) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>shortly ${escape(options.app)} (${escape(options.branch)})</title>
<style>*{box-sizing:border-box}body{margin:0;font:14px/1.55 -apple-system,"Segoe UI",Roboto,sans-serif;color:#181d27}
header{background:#111827;color:#fff;padding:12px 20px;display:flex;gap:14px;align-items:center}header b{font-size:16px}
.branch{padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px}main{padding:18px 20px;max-width:960px}
h2{font-size:16px;margin:20px 0 8px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 9px;border-bottom:1px solid #e9eaeb;text-align:left}
code{font:12px ui-monospace,Menlo,monospace;background:#f5f5f5;padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}
.panel{border:1px solid #e9eaeb;border-left:3px solid #7c3aed;background:#f5f3ff;padding:10px 14px}.panel dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:0}.panel dt{color:#535862}.panel dd{margin:0}
form{display:flex;gap:8px}input{flex:1;padding:7px 9px;border:1px solid #d5d7da;border-radius:4px;font:inherit}button{background:#7c3aed;color:#fff;border:0;border-radius:4px;padding:7px 14px;font:inherit;cursor:pointer}
.muted{color:#535862}</style></head>
<body><header><b>shortly</b><span>${escape(options.app)}</span><span class="branch" style="background:hsl(${hue(options.branch)} 70% 88%);color:hsl(${hue(options.branch)} 60% 22%)">${escape(options.branch)}</span><span class="muted" style="color:#9ca3af">Bun, .env files, Redis per worktree</span></header>
<main>${options.body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  )

export const panel = (rows: ReadonlyArray<readonly [string, unknown]>) =>
  `<div class="panel"><dl>${rows.map(([label, value]) => `<dt>${escape(label)}</dt><dd><code>${escape(value)}</code></dd>`).join("")}</dl></div>`

export const table = (columns: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
  rows.length === 0
    ? `<p class="muted"><i>Nothing yet.</i></p>`
    : `<table><tr>${columns.map((column) => `<th>${escape(column)}</th>`).join("")}</tr>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("")}</table>`

export const queueKey = () => `${process.env.REDIS_PREFIX ?? ""}shortly:jobs`
