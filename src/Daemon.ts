import { NodeHttpPlatform, NodeHttpServer, NodeSocketServer } from "@effect/platform-node"
import { Effect, Layer, References } from "effect"
import {
  Etag,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer
} from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import * as Api from "./Api.ts"
import { DaemonLog } from "./DaemonLog.ts"
import { ProcessUsage } from "./Usage.ts"
import { EnvResolver } from "./Env.ts"
import type { Port } from "./Ids.ts"
import { InfraManager } from "./InfraManager.ts"
import * as Platform from "./Platform.ts"
import { Proc } from "./Proc.ts"
import { ForkyardRpcs } from "./Protocol.ts"
import * as Proxy from "./Proxy.ts"
import { Registry } from "./Registry.ts"
import { Router } from "./Router.ts"
import { Runs } from "./Runs.ts"
import { Status } from "./Status.ts"
import * as Store from "./Store.ts"
import { Supervisor } from "./Supervisor.ts"
import { Maple, observability, type TelemetryTarget } from "./Telemetry.ts"
import { Worktrees } from "./Worktrees.ts"

export type DaemonOptions = {
  readonly socket: string
  readonly stateFile: string
  readonly traefikDir: string
  readonly upstreamHost: string
  readonly proxyPort: Port
  readonly httpPort: Port
  readonly maplePort: Port
  readonly dashboardDir: string
  readonly domain: string
  readonly version: string
  readonly startupConcurrency: number
  readonly proxyMode: "docker" | "binary"
  readonly telemetry: TelemetryTarget
  readonly hostsFile: string | undefined
}

const forwardTelemetry = Effect.fn("Daemon.forwardTelemetry")(
  function* (otlpUrl: string) {
    const http = yield* HttpClient.HttpClient
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = new Uint8Array(yield* request.arrayBuffer)
    const target = `${otlpUrl}${request.url.replace(/^\/otlp/, "")}`
    const contentType = request.headers["content-type"] ?? "application/json"

    const response = yield* http.execute(HttpClientRequest.post(target).pipe(HttpClientRequest.bodyUint8Array(body, contentType)))

    return HttpServerResponse.empty({ status: response.status })
  },
  Effect.orDie,
  Effect.withTracerEnabled(false)
)

const otlpProxy = (otlpUrl: string) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      yield* router.add("POST", "/otlp/*", forwardTelemetry(otlpUrl).pipe(Effect.provideService(HttpClient.HttpClient, http)))
    })
  )

const fromForeignPage = (request: HttpServerRequest.HttpServerRequest, allowedOrigins: ReadonlyArray<string>) => {
  const origin = request.headers["origin"]
  if (!request.url.startsWith("/rpc")) return false
  if (!origin) return false
  return !allowedOrigins.includes(origin)
}

const dashboardOnly = (allowedOrigins: ReadonlyArray<string>) =>
  HttpRouter.middleware(
    (httpEffect) =>
      HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap((request) =>
          fromForeignPage(request, allowedOrigins) ? Effect.succeed(HttpServerResponse.empty({ status: 403 })) : httpEffect
        )
      ),
    { global: true }
  )

const dashboardServer = (options: DaemonOptions, otlpUrl: string | undefined, dashboardUrl: string) =>
  HttpRouter.serve(
    Layer.mergeAll(
      dashboardOnly([dashboardUrl, `http://127.0.0.1:${options.httpPort}`, `http://localhost:${options.httpPort}`]),
      RpcServer.layer(ForkyardRpcs).pipe(Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" }))),
      otlpUrl ? otlpProxy(otlpUrl) : Layer.empty,
      HttpStaticServer.layer({ root: options.dashboardDir, spa: true, cacheControl: "no-store" })
    ),
    { disableLogger: true }
  ).pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(NodeHttpServer.layerServer(createServer, { port: options.httpPort, host: "127.0.0.1" })),
    Layer.provide(NodeHttpPlatform.layer),
    Layer.provide(Etag.layer)
  )

const cliServer = (options: DaemonOptions) =>
  RpcServer.layer(ForkyardRpcs).pipe(
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(NodeSocketServer.layer({ path: options.socket })),
    Layer.provide(Layer.succeed(References.UnhandledLogLevel, "Debug"))
  )

const otlpUrlOf = (options: DaemonOptions) => {
  if (options.telemetry._tag === "Off") return undefined
  if (options.telemetry._tag === "Remote") return options.telemetry.url
  return `http://127.0.0.1:${options.maplePort}`
}

const otlpHeadersOf = (options: DaemonOptions) =>
  options.telemetry._tag === "Remote"
    ? Object.entries(options.telemetry.headers)
        .map(([key, value]) => `${key}=${value}`)
        .join(",")
    : ""

const telemetryLayer = (options: DaemonOptions, otlpUrl: string | undefined) => {
  const resource = { serviceVersion: options.version, attributes: { "service.namespace": "forkyard" } }
  if (!otlpUrl) return Layer.empty
  if (options.telemetry._tag === "Remote") return observability(otlpUrl, options.telemetry.headers, resource)
  return observability(otlpUrl, {}, resource).pipe(
    Layer.provideMerge(Maple.layer({ port: options.maplePort, host: `maple.${options.domain}`, proxyPort: options.proxyPort }))
  )
}

export const layer = (options: DaemonOptions) => {
  const dashboardUrl = `http://forkyard.${options.domain}${options.proxyPort === 80 ? "" : `:${options.proxyPort}`}`
  const otlpUrl = otlpUrlOf(options)

  const records = Layer.mergeAll(
    Status.layer,
    FetchHttpClient.layer,
    Registry.layer,
    Runs.layer,
    Router.layer({ file: `${options.traefikDir}/forkyard.yml`, upstreamHost: options.upstreamHost, hostsFile: options.hostsFile })
  ).pipe(Layer.provideMerge(Store.layer(options.stateFile)), Layer.provideMerge(Platform.layer))

  const processes = Proc.layer({ otlpUrl }).pipe(Layer.provideMerge(records))

  const telemetry = telemetryLayer(options, otlpUrl)

  const worktrees = Worktrees.layer({ domain: options.domain, proxyPort: options.proxyPort }).pipe(
    Layer.provideMerge(Supervisor.layer({ startupConcurrency: options.startupConcurrency, otlpUrl, otlpHeaders: otlpHeadersOf(options) })),
    Layer.provideMerge(EnvResolver.layer),
    Layer.provideMerge(InfraManager.layer({ domain: options.domain, proxyPort: options.proxyPort }))
  )

  const announce = Layer.effectDiscard(Effect.logInfo(`forkyard on ${options.socket}, dashboard at ${dashboardUrl}`))

  const servers = Layer.mergeAll(
    announce,
    cliServer(options),
    dashboardServer(options, otlpUrl, dashboardUrl),
    Proxy.layer({
      mode: options.proxyMode,
      traefikDir: options.traefikDir,
      port: options.proxyPort,
      dashboardHost: `forkyard.${options.domain}`,
      dashboardPort: options.httpPort
    })
  )

  return servers.pipe(
    Layer.provide(Api.layer({ dashboardUrl })),
    Layer.provide(ProcessUsage.layer),
    Layer.provideMerge(worktrees),
    Layer.provide(telemetry),
    Layer.provideMerge(processes),
    Layer.provide(DaemonLog.logging)
  )
}
