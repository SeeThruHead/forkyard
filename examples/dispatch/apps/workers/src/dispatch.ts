import { type DispatchActivities, queues } from "@dispatch/workflows"
import { clientFor, handledBy, pool, record, runWorker } from "./shared.ts"

const namespace = process.env.TEMPORAL_NAMESPACE_DISPATCH ?? "dispatch"
const billing = await clientFor(process.env.TEMPORAL_NAMESPACE_BILLING ?? "billing")

const activities: DispatchActivities = {
  pickCourier: async (deliveryId) => {
    const { rows } = await pool.query<{ id: number; name: string }>("SELECT id, name FROM couriers ORDER BY random() LIMIT 1")
    const courier = rows[0]
    if (!courier) throw new Error("no couriers")
    await pool.query("UPDATE deliveries SET courier_id = $1 WHERE id = $2", [courier.id, deliveryId])
    await record(deliveryId, `courier ${courier.name} assigned`, namespace)
    return courier.name
  },
  requestCharge: async (deliveryId) => {
    await billing.workflow.start("chargeDelivery", { taskQueue: queues.billing, workflowId: `charge-${deliveryId}`, args: [deliveryId] })
    await record(deliveryId, "charge requested", namespace)
  },
  reconcile: async () => {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM deliveries")
    const deliveries = Number(rows[0]?.count ?? 0)
    await pool.query("INSERT INTO reconciliations (deliveries, handled_by) VALUES ($1, $2)", [deliveries, handledBy])
    console.log(`reconciled ${deliveries} deliveries`)
    return deliveries
  }
}

await runWorker(namespace, queues.dispatch, activities)
