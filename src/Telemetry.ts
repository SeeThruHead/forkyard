import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp, OtlpSerialization } from "effect/observability"
import { fileURLToPath } from "node:url"
import { cmd } from "./Stack.ts"
import { dockerContainer, fetchOk, readyOrExit } from "./infra/Shared.ts"
import { toolsFor } from "./InfraManager.ts"
import { Proc } from "./Proc.ts"
import { Router } from "./Router.ts"

export const telemetryDir = fileURLToPath(new URL("../telemetry", import.meta.url))

export const mapleImage = "forkyard-maple:v0.0.22"

export type TelemetryOptions = {
  readonly port: number
  readonly host: string
  readonly proxyPort: number
}

export class Maple extends Context.Service<Maple, {
  readonly otlpUrl: string
  readonly uiUrl: string
}>()("forkyard/Telemetry/Maple") {
  static readonly layer = (options: TelemetryOptions) =>
    Layer.effect(
      Maple,
      Effect.gen(function*() {
        const proc = yield* Proc
        const router = yield* Router
        const tools = toolsFor(proc, "forkyard")
        const otlpUrl = `http://127.0.0.1:${options.port}`

        const imagePresent = tools
          .exec({ name: "docker image inspect", run: cmd("docker", "image", "inspect", mapleImage), env: {}, cwd: telemetryDir })
          .pipe(Effect.scoped, Effect.as(true), Effect.orElseSucceed(() => false))

        if (!(yield* imagePresent)) {
          yield* Effect.logInfo(`building ${mapleImage}`)
          yield* tools
            .exec({ name: "docker build", run: cmd("docker", "build", "-t", mapleImage, "-f", "Maple.Dockerfile", "."), env: {}, cwd: telemetryDir })
            .pipe(Effect.scoped)
        }

        const started = yield* dockerContainer(tools, {
          infra: "maple",
          name: `forkyard-maple-${options.port}`,
          args: ["-p", `127.0.0.1:${options.port}:14318`, "-v", "forkyard-maple-data:/var/lib/maple/data", mapleImage]
        })

        yield* readyOrExit("maple", started, fetchOk(`${otlpUrl}/health`), "60 seconds")
        yield* router.expose({ host: options.host, port: options.port })
        const uiUrl = `http://${options.host}${options.proxyPort === 80 ? "" : `:${options.proxyPort}`}`
        yield* Effect.logInfo(`maple ready: OTLP ${otlpUrl}, UI ${uiUrl}`)
        return Maple.of({ otlpUrl, uiUrl })
      }).pipe(Effect.withSpan("Maple.start"), Effect.orDie)
    ).pipe(Layer.provide(FetchHttpClient.layer))
}

export const observability = (resource: { readonly serviceVersion: string; readonly attributes: Record<string, unknown> }) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const maple = yield* Maple
      return Otlp.layer({
        baseUrl: maple.otlpUrl,
        resource: { serviceName: "forkyard", serviceVersion: resource.serviceVersion, attributes: resource.attributes },
        loggerMergeWithExisting: true,
        loggerExportInterval: "1 second",
        tracerExportInterval: "1 second",
        metricsExportInterval: "5 seconds"
      })
    })
  ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
