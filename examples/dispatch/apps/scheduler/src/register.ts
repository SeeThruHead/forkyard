import { queues } from "@dispatch/workflows"
import { Client, Connection, ScheduleAlreadyRunning } from "@temporalio/client"

const namespace = process.env.TEMPORAL_NAMESPACE_DISPATCH ?? "dispatch"
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" })
const client = new Client({ connection, namespace })

const created = await client.schedule
  .create({
    scheduleId: "reconcile-every-minute",
    spec: { intervals: [{ every: "1 minute" }] },
    action: { type: "startWorkflow", workflowType: "reconcile", taskQueue: queues.dispatch, args: [] }
  })
  .then(() => true)
  .catch((error: unknown) => {
    if (error instanceof ScheduleAlreadyRunning) return false
    throw error
  })

console.log(
  created ? `created schedule reconcile-every-minute in ${namespace}` : `schedule reconcile-every-minute already exists in ${namespace}`
)
await connection.close()
