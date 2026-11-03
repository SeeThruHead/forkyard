import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

export const DeliveryEvent = Schema.Struct({ step: Schema.String, namespace: Schema.String, handledBy: Schema.String })

export const Delivery = Schema.Struct({
  id: Schema.Finite,
  address: Schema.String,
  courier: Schema.NullOr(Schema.String),
  events: Schema.Array(DeliveryEvent)
})

export const Created = Schema.Struct({ id: Schema.Finite, workflowId: Schema.String })

export const GatewayApi = HttpApi.make("gateway").add(
  HttpApiGroup.make("deliveries", { topLevel: true }).add(
    HttpApiEndpoint.get("health", "/health", { success: Schema.Struct({ status: Schema.Literal("ok") }) }),
    HttpApiEndpoint.get("list", "/deliveries", { success: Schema.Array(Delivery) }),
    HttpApiEndpoint.post("create", "/deliveries", { payload: Schema.Struct({ address: Schema.String }), success: Created })
  )
)
