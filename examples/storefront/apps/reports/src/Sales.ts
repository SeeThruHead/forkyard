import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { ProductSales } from "./Api.ts"

const SalesRow = Schema.Struct({
  sku: Schema.String,
  name: Schema.String,
  units: Schema.NumberFromString,
  revenue: Schema.NumberFromString
})

export class Sales extends Context.Service<
  Sales,
  {
    readonly byProduct: Effect.Effect<ReadonlyArray<typeof ProductSales.Type>>
  }
>()("reports/Sales") {
  static readonly layer = Layer.effect(
    Sales,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const query = SqlSchema.findAll({
        Request: Schema.Void,
        Result: SalesRow,
        execute: () => sql`
          SELECT p.sku, p.name, COALESCE(SUM(o.quantity), 0)::text AS units, COALESCE(SUM(o.quantity * p.price), 0)::text AS revenue
          FROM products p LEFT JOIN orders o ON o.product_id = p.id
          GROUP BY p.id ORDER BY p.id`
      })

      return Sales.of({
        byProduct: query(undefined).pipe(Effect.orDie, Effect.withSpan("Sales.byProduct"))
      })
    })
  )
}
