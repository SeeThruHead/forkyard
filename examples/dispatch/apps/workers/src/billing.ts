import { type BillingActivities, queues } from "@dispatch/workflows"
import { clientFor, record, runWorker } from "./shared.ts"

const namespace = process.env.TEMPORAL_NAMESPACE_BILLING ?? "billing"
const notifications = await clientFor(process.env.TEMPORAL_NAMESPACE_NOTIFICATIONS ?? "notifications")

const activities: BillingActivities = {
  charge: async (deliveryId) => {
    await record(deliveryId, "card charged", namespace)
  },
  requestReceipt: async (deliveryId) => {
    await notifications.workflow.start("sendReceipt", {
      taskQueue: queues.notifications,
      workflowId: `receipt-${deliveryId}`,
      args: [deliveryId]
    })
    await record(deliveryId, "receipt requested", namespace)
  }
}

await runWorker(namespace, queues.billing, activities)
