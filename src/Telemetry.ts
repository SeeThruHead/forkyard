import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp, OtlpSerialization } from "effect/observability"
import { fileURLToPath } from "node:url"
import type { Port } from "./Ids.ts"
import { dockerContainer, fetchOk, readyOrExit } from "./infra/Shared.ts"
import { toolsFor } from "./InfraManager.ts"
import { Proc } from "./Proc.ts"
import { Router } from "./Router.ts"
import { cmd, type InfraTools } from "./Stack.ts"

export const telemetryDir = fileURLToPath(new URL("../telemetry", import.meta.url))

export const mapleImage = "forkyard-maple:v0.0.22"

export type TelemetryOptions = {
  readonly port: Port
  readonly host: string
  readonly proxyPort: Port
}

const imagePresent = (tools: InfraTools) =>
  tools.exec({ name: "docker image inspect", run: cmd("docker", "image", "inspect", mapleImage), env: {}, cwd: telemetryDir }).pipe(
    Effect.scoped,
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )

const buildImage = (tools: InfraTools) =>
  tools
    .exec({
      name: "docker build",
      run: cmd("docker", "build", "-t", mapleImage, "-f", "Maple.Dockerfile", "."),
      env: {},
      cwd: telemetryDir
    })
    .pipe(
      Effect.scoped,
      Effect.tap(() => Effect.logInfo(`built ${mapleImage}`))
    )

const ensureImage = Effect.fn("Maple.ensureImage")(function* (tools: InfraTools) {
  if (yield* imagePresent(tools)) return
  yield* buildImage(tools)
})

const proxySuffix = (port: Port) => (port === 80 ? "" : `:${port}`)

export class Maple extends Context.Service<
  Maple,
  {
    readonly otlpUrl: string
    readonly uiUrl: string
  }
>()("forkyard/Telemetry/Maple") {
  static readonly layer = (options: TelemetryOptions) =>
    Layer.effect(
      Maple,
      Effect.gen(function* () {
        const proc = yield* Proc
        const router = yield* Router
        const tools = toolsFor(proc, "forkyard")
        const otlpUrl = `http://127.0.0.1:${options.port}`

        yield* ensureImage(tools)
        const started = yield* dockerContainer(tools, {
          infra: "maple",
          name: `forkyard-maple-${options.port}`,
          args: ["-p", `127.0.0.1:${options.port}:14318`, "-v", "forkyard-maple:/var/lib/maple", mapleImage]
        })

        yield* readyOrExit("maple", started, fetchOk(`${otlpUrl}/health`), "60 seconds")
        yield* router.expose({ host: options.host, port: options.port })

        return Maple.of({ otlpUrl, uiUrl: `http://${options.host}${proxySuffix(options.proxyPort)}` })
      }).pipe(
        Effect.withSpan("Maple.start"),
        Effect.tap((maple) => Effect.logInfo(`maple ready: OTLP ${maple.otlpUrl}, UI ${maple.uiUrl}`)),
        Effect.orDie
      )
    ).pipe(Layer.provide(FetchHttpClient.layer))
}

export const observability = (resource: { readonly serviceVersion: string; readonly attributes: Record<string, unknown> }) =>
  Layer.unwrap(
    Effect.gen(function* () {
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
