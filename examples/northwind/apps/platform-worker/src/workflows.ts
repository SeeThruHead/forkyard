import { proxyActivities } from "@temporalio/workflow"
import type { PlatformActivities } from "./activities.ts"

const activities = proxyActivities<PlatformActivities>({ startToCloseTimeout: "15 seconds" })

export async function fulfilOrder(orderId: number): Promise<void> {
  await activities.reserveStock(orderId)
  await activities.requestCharge(orderId)
}

export async function dailyDigest(): Promise<number> {
  return activities.writeDigest()
}

export async function bulkRenotify(orderIds: ReadonlyArray<number>): Promise<void> {
  await Promise.all(orderIds.map((orderId) => activities.renotify(orderId)))
}
