import { NodeHttpClient } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { Otlp, OtlpSerialization } from "effect/observability"

export const TelemetryLive = Layer.unwrap(
  Effect.gen(function* () {
    const baseUrl = yield* Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")

    return Otlp.layer({ baseUrl }).pipe(Layer.provide([NodeHttpClient.layerUndici, OtlpSerialization.layerJson]))
  })
)
