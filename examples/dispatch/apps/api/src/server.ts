import { tables } from "@dispatch/db"
import { queues } from "@dispatch/workflows"
import { Client, Connection } from "@temporalio/client"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233"
const namespace = process.env.TEMPORAL_NAMESPACE_DISPATCH ?? "dispatch"
const temporal = new Client({ connection: await Connection.connect({ address }), namespace })
const startedAt = new Date().toISOString()

const deliveriesSql = `
  SELECT d.id, d.address, c.name AS courier,
    COALESCE(json_agg(json_build_object('step', e.step, 'namespace', e.namespace, 'handledBy', e.handled_by) ORDER BY e.id)
      FILTER (WHERE e.id IS NOT NULL), '[]') AS events
  FROM deliveries d
  LEFT JOIN couriers c ON c.id = d.courier_id
  LEFT JOIN delivery_events e ON e.delivery_id = d.id
  GROUP BY d.id, c.name
  ORDER BY d.id DESC`

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const readJson = async (request: IncomingMessage) => {
  const text = Buffer.concat((await request.toArray()) as Array<Buffer>).toString()
  return text ? JSON.parse(text) : {}
}

const info = async () => ({
  app: "api",
  branch: process.env.FORKYARD_BRANCH ?? "local",
  pid: process.pid,
  startedAt,
  database: (await pool.query("SELECT current_database() AS name")).rows[0].name,
  tables,
  temporal: { address, namespace }
})

const createDelivery = async (request: IncomingMessage) => {
  const body = await readJson(request)
  const { rows } = await pool.query<{ id: number }>("INSERT INTO deliveries (address) VALUES ($1) RETURNING id", [
    String(body.address ?? "1 Main St")
  ])
  const id = rows[0]!.id
  await temporal.workflow.start("dispatchDelivery", { taskQueue: queues.dispatch, workflowId: `delivery-${id}`, args: [id] })
  return { id, workflowId: `delivery-${id}` }
}

const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>> = {
  "GET /health": async (_request, response) => json(response, 200, { ok: true }),
  "GET /info": async (_request, response) => json(response, 200, await info()),
  "GET /deliveries": async (_request, response) => json(response, 200, (await pool.query(deliveriesSql)).rows),
  "POST /deliveries": async (request, response) => json(response, 201, await createDelivery(request))
}

const handle = async (request: IncomingMessage, response: ServerResponse) => {
  const route = routes[`${request.method} ${new URL(request.url ?? "/", "http://x").pathname}`]
  if (!route) return json(response, 404, { error: "not found" })
  await route(request, response).catch((error: Error) => json(response, 500, { error: error.message }))
}

createServer((request, response) => void handle(request, response)).listen(Number(process.env.PORT ?? 4100), "127.0.0.1", () =>
  console.log(`api listening on ${process.env.PORT ?? 4100}, pid ${process.pid}`)
)
