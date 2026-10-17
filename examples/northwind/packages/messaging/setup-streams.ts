import { AckPolicy, connect } from "nats"

const nats = await connect({ servers: process.env.NATS_URL })
const manager = await nats.jetstreamManager()

await manager.streams
  .add({ name: "ORDERS", subjects: ["orders.>"] })
  .catch(() => manager.streams.update("ORDERS", { subjects: ["orders.>"] }))
await manager.consumers.add("ORDERS", { durable_name: "event-handlers", ack_policy: AckPolicy.Explicit })

console.log(`stream ORDERS and consumer event-handlers ready on ${process.env.NATS_URL}`)
await nats.close()
