import { proxyActivities } from "@temporalio/workflow"
import type { BillingActivities, DispatchActivities, NotificationActivities } from "./index.ts"

const timeouts = { startToCloseTimeout: "10 seconds" } as const

export async function dispatchDelivery(deliveryId: number): Promise<string> {
  const { pickCourier, requestCharge } = proxyActivities<DispatchActivities>(timeouts)
  const courier = await pickCourier(deliveryId)
  await requestCharge(deliveryId)
  return courier
}

export async function chargeDelivery(deliveryId: number): Promise<void> {
  const { charge, requestReceipt } = proxyActivities<BillingActivities>(timeouts)
  await charge(deliveryId)
  await requestReceipt(deliveryId)
}

export async function sendReceipt(deliveryId: number): Promise<void> {
  const activities = proxyActivities<NotificationActivities>(timeouts)
  await activities.sendReceipt(deliveryId)
}

export async function reconcile(): Promise<number> {
  const activities = proxyActivities<DispatchActivities>(timeouts)
  return activities.reconcile()
}
