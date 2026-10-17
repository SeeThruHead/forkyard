import { pool, post, who } from "@northwind/kit"

export type PlatformActivities = {
  readonly reserveStock: (orderId: number) => Promise<void>
  readonly requestCharge: (orderId: number) => Promise<void>
  readonly writeDigest: () => Promise<number>
  readonly renotify: (orderId: number) => Promise<void>
}

const db = pool()
const me = who("platform-worker")

const record = (orderId: number, step: string) =>
  db.query("INSERT INTO order_events (order_id, step, handled_by) VALUES ($1, $2, $3)", [orderId, step, me])

export const activities: PlatformActivities = {
  reserveStock: async (orderId) => {
    await record(orderId, "stock reserved (platform namespace)")
  },
  requestCharge: async (orderId) => {
    await post(
      `${process.env.BILLING_API_URL}/internal/charges`,
      { orderId },
      { "x-internal-secret": process.env.BILLING_INTERNAL_HTTP_SHARED_SECRET ?? "" }
    )
    await record(orderId, "charge requested from billing")
  },
  writeDigest: async () => {
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM orders")
    await db.query("INSERT INTO digests (orders, handled_by) VALUES ($1, $2)", [rows[0]!.n, me])
    return rows[0]!.n
  },
  renotify: async (orderId) => {
    await record(orderId, "renotified (bulk-actions namespace)")
  }
}
