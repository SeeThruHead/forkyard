import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

export const ProductSales = Schema.Struct({
  sku: Schema.String,
  name: Schema.String,
  units: Schema.Number,
  revenue: Schema.Number
})

export const ReportsApi = HttpApi.make("reports").add(
  HttpApiGroup.make("reports", { topLevel: true }).add(
    HttpApiEndpoint.get("health", "/health", { success: Schema.Struct({ status: Schema.Literal("ok") }) }),
    HttpApiEndpoint.get("sales", "/sales", { success: Schema.Array(ProductSales) })
  )
)
