import { pool, who } from "@northwind/kit"
import { connect } from "nats"

const db = pool()
const me = who("event-handlers")
const nats = await connect({ servers: process.env.NATS_URL })
const consumer = await nats.jetstream().consumers.get("ORDERS", "event-handlers")
const messages = await consumer.consume()

console.log(`event-handlers ready: consuming ORDERS (${me})`)

for await (const message of messages) {
  const order = message.json<{ id: number }>()
  await db.query("INSERT INTO order_events (order_id, step, handled_by) VALUES ($1, $2, $3)", [order.id, `${message.subject} handled`, me])
  message.ack()
}
