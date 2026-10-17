import { branch, internalSecretOk, ok, pool, readJson, serve } from "@northwind/kit"
import { Client, Connection } from "@temporalio/client"

const db = pool()
const temporal = new Client({
  connection: await Connection.connect({ address: process.env.TEMPORAL_ADDRESS }),
  namespace: process.env.TEMPORAL_NAMESPACE
})

serve("billing-api", Number(process.env.PORT ?? 3100), {
  "GET /health": async () => ok({ ok: true }),
  "GET /info": async () =>
    ok({
      app: "billing-api",
      branch,
      database: (await db.query("SELECT current_database() AS name")).rows[0].name,
      temporal: process.env.TEMPORAL_ADDRESS
    }),
  "GET /charges": async () => ok((await db.query("SELECT * FROM charges ORDER BY id DESC LIMIT 20")).rows),
  "POST /internal/charges": async (request) => {
    if (!internalSecretOk(request)) return ok({ error: "bad internal secret" }, 401)
    const { orderId } = await readJson(request)
    const { rows } = await db.query<{ id: number }>("INSERT INTO charges (order_id, amount) VALUES ($1, 14.00) RETURNING id", [orderId])
    const chargeId = rows[0]!.id
    await temporal.workflow.start("chargeOrder", { taskQueue: "billing", workflowId: `charge-${chargeId}`, args: [chargeId, orderId] })
    return ok({ chargeId }, 201)
  }
})
