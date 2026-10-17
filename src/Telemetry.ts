import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp, OtlpSerialization } from "effect/observability"
import { telemetryDir } from "./Package.ts"
import type { Port } from "./Ids.ts"
import { dockerContainer, dockerReach, dockerUpstream, fetchOk, forkyardName, publish, readyOrExit } from "./infra/Shared.ts"
import { toolsFor } from "./InfraManager.ts"
import { Proc } from "./Proc.ts"
import { Router } from "./Router.ts"
import { cmd, type InfraTools } from "./Stack.ts"

export { telemetryDir }

export const mapleImage = "forkyard-maple:v0.0.22"

const defaultMaplePort = 14418

const mapleVolume = (port: number) => (port === defaultMaplePort ? forkyardName("maple") : forkyardName("maple", port))

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
        const otlpUrl = `http://${dockerReach}:${options.port}`

        yield* ensureImage(tools)
        const started = yield* dockerContainer(tools, {
          infra: "maple",
          name: forkyardName("maple", options.port),
          args: ["-p", publish(options.port, 14318), "-v", `${mapleVolume(options.port)}:/var/lib/maple`, mapleImage]
        })

        yield* readyOrExit("maple", started, fetchOk(`${otlpUrl}/health`), "60 seconds")
        yield* router.expose({ host: options.host, port: options.port, ...(dockerUpstream ? { upstream: dockerUpstream } : {}) })

        return Maple.of({ otlpUrl, uiUrl: `http://${options.host}${proxySuffix(options.proxyPort)}` })
      }).pipe(
        Effect.withSpan("Maple.start"),
        Effect.tap((maple) => Effect.logInfo(`maple ready: OTLP ${maple.otlpUrl}, UI ${maple.uiUrl}`)),
        Effect.orDie
      )
    ).pipe(Layer.provide(FetchHttpClient.layer))
}

export type TelemetryTarget =
  | { readonly _tag: "Local" }
  | { readonly _tag: "Remote"; readonly url: string; readonly headers: Readonly<Record<string, string>> }
  | { readonly _tag: "Off" }

export const parseHeaders = (raw: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    raw
      .split(",")
      .map((pair) => pair.split("="))
      .filter((parts) => parts.length >= 2 && parts[0]!.trim() !== "")
      .map(([key, ...value]) => [key!.trim(), value.join("=").trim()])
  )

export const observability = (
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  resource: { readonly serviceVersion: string; readonly attributes: Record<string, unknown> }
) =>
  Otlp.layer({
    baseUrl,
    headers,
    resource: { serviceName: "forkyard", serviceVersion: resource.serviceVersion, attributes: resource.attributes },
    loggerMergeWithExisting: true,
    loggerExportInterval: "1 second",
    tracerExportInterval: "1 second",
    metricsExportInterval: "5 seconds"
  }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
