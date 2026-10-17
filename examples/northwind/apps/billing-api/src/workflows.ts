import { proxyActivities } from "@temporalio/workflow"
import type { BillingActivities } from "./activities.ts"

const activities = proxyActivities<BillingActivities>({ startToCloseTimeout: "15 seconds" })

export async function chargeOrder(chargeId: number, orderId: number): Promise<void> {
  await activities.capture(chargeId)
  await activities.notifyCore(orderId)
}
