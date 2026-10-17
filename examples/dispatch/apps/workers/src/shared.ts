import { Client, Connection } from "@temporalio/client"
import { NativeConnection, Worker } from "@temporalio/worker"
import { fileURLToPath } from "node:url"
import pg from "pg"

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })

const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233"

export const handledBy = `${process.env.FORKYARD_SERVICE ?? "worker"} pid ${process.pid} on ${process.env.FORKYARD_BRANCH ?? "local"}`

export const record = async (deliveryId: number, step: string, namespace: string) => {
  await pool.query("INSERT INTO delivery_events (delivery_id, step, namespace, handled_by) VALUES ($1, $2, $3, $4)", [
    deliveryId,
    step,
    namespace,
    handledBy
  ])
}

export const clientFor = async (namespace: string) => new Client({ connection: await Connection.connect({ address }), namespace })

export const runWorker = async (namespace: string, taskQueue: string, activities: object) => {
  const connection = await NativeConnection.connect({ address })
  const workflowsPath = fileURLToPath(import.meta.resolve("@dispatch/workflows/workflows"))
  const worker = await Worker.create({ connection, namespace, taskQueue, activities, workflowsPath })

  console.log(`worker ready: namespace ${namespace}, queue ${taskQueue}, ${handledBy}`)
  await worker.run()
  await connection.close()
  await pool.end()
}
