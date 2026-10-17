import { branch, internalSecretOk, ok, pool, readJson, serve, who } from "@northwind/kit"
import { Client, Connection } from "@temporalio/client"
import { Queue } from "bullmq"
import { connect } from "nats"

const db = pool()
const me = who("core-api")
const redis = { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) }
const email = new Queue("email", { connection: redis })
const nats = await connect({ servers: process.env.NATS_URL })
const temporal = new Client({
  connection: await Connection.connect({ address: process.env.TEMPORAL_PLATFORM_ADDRESS }),
  namespace: process.env.TEMPORAL_PLATFORM_NAMESPACE
})

const ordersSql = `
  SELECT o.id, o.sku, o.email, o.status,
    COALESCE(json_agg(json_build_object('step', e.step, 'by', e.handled_by) ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL), '[]') AS events
  FROM orders o LEFT JOIN order_events e ON e.order_id = o.id
  GROUP BY o.id ORDER BY o.id DESC LIMIT 20`

const record = (orderId: number, step: string, by = me) =>
  db.query("INSERT INTO order_events (order_id, step, handled_by) VALUES ($1, $2, $3)", [orderId, step, by])

const placeOrder = async (body: Record<string, any>) => {
  const sku = String(body.sku ?? "MUG-01")
  const address = String(body.email ?? "someone@example.com")
  const { rows } = await db.query<{ id: number }>("INSERT INTO orders (sku, email) VALUES ($1, $2) RETURNING id", [sku, address])
  const id = rows[0]!.id
  await db.query("INSERT INTO outbox (subject, payload) VALUES ($1, $2)", ["orders.placed", { id, sku }])
  await record(id, "placed")
  await email.add("order-confirmation", { orderId: id, to: address })
  await temporal.workflow.start("fulfilOrder", { taskQueue: "platform", workflowId: `order-${id}`, args: [id] })
  return { id }
}

serve("core-api", Number(process.env.PORT ?? 8181), {
  "GET /public/health": async () => ok({ ok: true }),
  "GET /info": async () =>
    ok({
      app: "core-api",
      branch,
      pid: process.pid,
      database: (await db.query("SELECT current_database() AS name")).rows[0].name,
      nats: process.env.NATS_URL,
      redis: `${redis.host}:${redis.port}`,
      temporal: process.env.TEMPORAL_PLATFORM_ADDRESS,
      authIssuer: process.env.AUTH_ISSUER,
      flags: process.env.FLAGS_BASE_URL
    }),
  "GET /skus": async () => ok(await (await fetch(`${process.env.CATALOG_URL}/skus`)).json()),
  "GET /orders": async () => ok((await db.query(ordersSql)).rows),
  "POST /orders": async (request) => ok(await placeOrder(await readJson(request)), 201),
  "POST /internal/orders/:id/paid": async (request, params) => {
    if (!internalSecretOk(request)) return ok({ error: "bad internal secret" }, 401)
    const body = await readJson(request)
    await db.query("UPDATE orders SET status = 'paid' WHERE id = $1", [Number(params.id)])
    await record(Number(params.id), "marked paid", String(body.by ?? "billing"))
    nats.publish("orders.paid", JSON.stringify({ id: Number(params.id) }))
    return ok({ ok: true })
  },
  "POST /webhooks/kyc": async (request) => {
    const body = await readJson(request)
    await db.query("INSERT INTO kyc_events (status, handled_by) VALUES ($1, $2)", [String(body.status), me])
    return ok({ received: true })
  },
  "GET /kyc": async () => ok((await db.query("SELECT * FROM kyc_events ORDER BY id DESC LIMIT 10")).rows),
  "GET /auth/callback": async (_request, _params, url) => {
    const response = await fetch(`${process.env.AUTH_ISSUER}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: url.searchParams.get("code") })
    })
    return ok(await response.json(), response.status)
  }
})
