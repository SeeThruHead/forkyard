import "varlock/auto-load"
import { Client, Connection, ScheduleAlreadyRunning } from "@temporalio/client"
import { NativeConnection, Worker } from "@temporalio/worker"
import { ENV } from "varlock/env"
import { fileURLToPath } from "node:url"
import { activities } from "./activities.ts"

const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url))

const workerFor = async (address: string, namespace: string, taskQueue: string) =>
  Worker.create({ connection: await NativeConnection.connect({ address }), namespace, taskQueue, workflowsPath, activities })

const scheduleDigest = async () => {
  const client = new Client({
    connection: await Connection.connect({ address: ENV.TEMPORAL_CRONS_ADDRESS }),
    namespace: ENV.TEMPORAL_CRONS_NAMESPACE
  })
  await client.schedule
    .create({
      scheduleId: "daily-digest",
      spec: { intervals: [{ every: "1 day" }] },
      action: { type: "startWorkflow", workflowType: "dailyDigest", taskQueue: "crons", args: [] }
    })
    .catch((error: unknown) => {
      if (!(error instanceof ScheduleAlreadyRunning)) throw error
    })
}

const workers = await Promise.all([
  workerFor(ENV.TEMPORAL_PLATFORM_ADDRESS, ENV.TEMPORAL_PLATFORM_NAMESPACE, "platform"),
  workerFor(ENV.TEMPORAL_CRONS_ADDRESS, ENV.TEMPORAL_CRONS_NAMESPACE, "crons"),
  workerFor(ENV.TEMPORAL_BULK_ADDRESS, ENV.TEMPORAL_BULK_NAMESPACE, "bulk-actions")
])
await scheduleDigest()

console.log(`platform-worker ready: ${ENV.TEMPORAL_PLATFORM_ADDRESS} namespaces platform, crons, bulk-actions`)
await Promise.all(workers.map((worker) => worker.run()))
