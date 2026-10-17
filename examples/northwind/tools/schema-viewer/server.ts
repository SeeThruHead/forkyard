import { ok, pool, serve } from "@northwind/kit"

const db = pool()

serve("schema-viewer", Number(process.env.SCHEMA_VIEWER_PORT ?? 4421), {
  "GET /health": async () => ok({ ok: true }),
  "GET /": async () => {
    const { rows } = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")
    const database = (await db.query("SELECT current_database() AS name")).rows[0].name
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<h1>${database}</h1><ul>${rows.map((row) => `<li>${row.table_name}</li>`).join("")}</ul>`
    }
  }
})
