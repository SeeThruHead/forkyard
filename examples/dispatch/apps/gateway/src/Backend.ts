import { Config, Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Created, Delivery } from "./Api.ts"

export class Backend extends Context.Service<
  Backend,
  {
    readonly deliveries: Effect.Effect<ReadonlyArray<typeof Delivery.Type>>
    readonly create: (address: string) => Effect.Effect<typeof Created.Type>
  }
>()("gateway/Backend") {
  static readonly layer = Layer.effect(
    Backend,
    Effect.gen(function* () {
      const apiUrl = yield* Config.String("API_URL")
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(apiUrl)),
        HttpClient.filterStatusOk
      )

      const deliveries = client
        .get("/deliveries")
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(Delivery))),
          Effect.orDie,
          Effect.withSpan("Backend.deliveries")
        )

      const create = (address: string) =>
        HttpClientRequest.post("/deliveries").pipe(
          HttpClientRequest.bodyJsonUnsafe({ address }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Created)),
          Effect.orDie,
          Effect.withSpan("Backend.create")
        )

      return Backend.of({ deliveries, create })
    })
  )
}
