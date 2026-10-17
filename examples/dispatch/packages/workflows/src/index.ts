export const queues = {
  dispatch: "dispatch",
  billing: "billing",
  notifications: "notifications"
} as const

export type DispatchActivities = {
  readonly pickCourier: (deliveryId: number) => Promise<string>
  readonly requestCharge: (deliveryId: number) => Promise<void>
  readonly reconcile: () => Promise<number>
}

export type BillingActivities = {
  readonly charge: (deliveryId: number) => Promise<void>
  readonly requestReceipt: (deliveryId: number) => Promise<void>
}

export type NotificationActivities = {
  readonly sendReceipt: (deliveryId: number) => Promise<void>
}
