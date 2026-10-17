import { pool, post, who } from "@northwind/kit"

export type BillingActivities = {
  readonly capture: (chargeId: number) => Promise<void>
  readonly notifyCore: (orderId: number) => Promise<void>
}

const db = pool()
const me = who("billing-worker")

export const activities: BillingActivities = {
  capture: async (chargeId) => {
    await db.query("UPDATE charges SET status = 'captured', handled_by = $2 WHERE id = $1", [chargeId, me])
  },
  notifyCore: async (orderId) => {
    await post(
      `${process.env.CORE_API_URL}/internal/orders/${orderId}/paid`,
      { by: me },
      { "x-internal-secret": process.env.CORE_API_INTERNAL_HTTP_SHARED_SECRET ?? "" }
    )
  }
}
