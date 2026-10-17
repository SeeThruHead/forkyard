import { ok, pool, serve, who } from "@northwind/kit"
import { connect } from "nats"

const db = pool()
const me = who("outbox")
const nats = await connect({ servers: process.env.NATS_URL })
const jetstream = nats.jetstream()

const drain = async () => {
  const { rows } = await db.query<{ id: number; subject: string; payload: unknown }>(
    "SELECT id, subject, payload FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT 50"
  )
  await rows.reduce(
    (previous: Promise<void>, row) =>
      previous.then(async () => {
        await jetstream.publish(row.subject, JSON.stringify(row.payload))
        await db.query("UPDATE outbox SET sent_at = now() WHERE id = $1", [row.id])
        await db.query("INSERT INTO order_events (order_id, step, handled_by) VALUES ($1, $2, $3)", [
          (row.payload as { id: number }).id,
          `published ${row.subject}`,
          me
        ])
      }),
    Promise.resolve()
  )
}

serve("outbox health", Number(process.env.HEALTH_PORT ?? 3103), { "GET /health": async () => ok({ ok: true }) })
setInterval(() => drain().catch((error: Error) => console.error(`outbox drain failed: ${error.message}`)), 500)
console.log(`outbox ready (${me})`)
