import { branch, ok, pool, readJson, serve } from "@northwind/kit"

const db = pool()

const resolvers: Record<string, () => Promise<unknown>> = {
  orders: async () => (await db.query("SELECT id, sku, status FROM orders ORDER BY id DESC LIMIT 20")).rows,
  kycEvents: async () => (await db.query("SELECT id, status FROM kyc_events ORDER BY id DESC LIMIT 5")).rows,
  meta: async () => ({ branch, database: (await db.query("SELECT current_database() AS name")).rows[0].name })
}

const execute = async (query: string) => {
  const fields = Object.keys(resolvers).filter((field) => new RegExp(`\\b${field}\\b`).test(query))
  const values = await Promise.all(fields.map((field) => resolvers[field]!()))
  return { data: Object.fromEntries(fields.map((field, index) => [field, values[index]])) }
}

serve("graph", Number(process.env.PORT ?? 4100), {
  "GET /health": async () => ok({ ok: true }),
  "POST /graphql": async (request) => ok(await execute(String((await readJson(request)).query ?? "")))
})
