import { type NotificationActivities, queues } from "@dispatch/workflows"
import { record, runWorker } from "./shared.ts"

const namespace = process.env.TEMPORAL_NAMESPACE_NOTIFICATIONS ?? "notifications"

const activities: NotificationActivities = {
  sendReceipt: async (deliveryId) => {
    await record(deliveryId, "receipt emailed", namespace)
  }
}

await runWorker(namespace, queues.notifications, activities)
