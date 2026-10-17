import { pool, post, who } from "@northwind/kit"
import { Queue, Worker } from "bullmq"

const db = pool()
const me = who("jobs")
const connection = { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) }

const sendConfirmation = async (orderId: number, to: string) => {
  await post(`${process.env.MAIL_API_BASE}/v3/northwind.test/messages`, {
    to,
    subject: `Order ${orderId} confirmed`,
    text: `Your order ${orderId} is on its way.`
  })
  await db.query("INSERT INTO order_events (order_id, step, handled_by) VALUES ($1, $2, $3)", [orderId, "confirmation emailed", me])
}

const worker = new Worker("email", async (job) => sendConfirmation(job.data.orderId, job.data.to), { connection })
await new Queue("maintenance", { connection }).upsertJobScheduler("hourly-cleanup", { every: 3_600_000 })
const cron = new Worker("maintenance", async () => console.log("hourly cleanup ran"), { connection })

console.log(`jobs ready: queues email, maintenance (${me})`)
const shutdown = async () => {
  await Promise.all([worker.close(), cron.close()])
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
