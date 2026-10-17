import { ok, serve } from "@northwind/kit"
import { NativeConnection, Worker } from "@temporalio/worker"
import { fileURLToPath } from "node:url"
import { activities } from "./activities.ts"

const worker = await Worker.create({
  connection: await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS }),
  namespace: process.env.TEMPORAL_NAMESPACE ?? "billing",
  taskQueue: "billing",
  workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
  activities
})

serve("billing-worker health", Number(process.env.HEALTH_PORT ?? 3102), { "GET /ready": async () => ok({ ready: true }) })
console.log(`billing-worker ready on ${process.env.TEMPORAL_ADDRESS}`)
await worker.run()
