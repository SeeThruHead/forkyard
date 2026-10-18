import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp, OtlpSerialization } from "effect/observability"

export type TelemetryTarget = { readonly url: string; readonly headers: Readonly<Record<string, string>> }

export const parseHeaders = (raw: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    raw
      .split(",")
      .map((pair) => pair.split("="))
      .filter((parts) => parts.length >= 2 && parts[0]!.trim() !== "")
      .map(([key, ...value]) => [key!.trim(), value.join("=").trim()])
  )

export const observability = (
  target: TelemetryTarget,
  resource: { readonly serviceVersion: string; readonly attributes: Record<string, unknown> }
) =>
  Otlp.layer({
    baseUrl: target.url,
    headers: target.headers,
    resource: { serviceName: "forkyard", serviceVersion: resource.serviceVersion, attributes: resource.attributes },
    loggerMergeWithExisting: true,
    loggerExportInterval: "1 second",
    tracerExportInterval: "1 second",
    metricsExportInterval: "5 seconds"
  }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
