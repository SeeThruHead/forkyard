export const tables = ["couriers", "deliveries", "delivery_events", "reconciliations"] as const

export type Table = (typeof tables)[number]
