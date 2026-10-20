import { NodeHttpPlatform, NodeHttpServer, NodeSocketServer } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Option, References } from "effect"
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
import { Instances } from "./Instances.ts"
import { Sharing } from "./Sharing.ts"
import * as Platform from "./Platform.ts"
import { Proc } from "./Proc.ts"
import { ForkyardRpcs } from "./Protocol.ts"
import * as Proxy from "./Proxy.ts"
import { ProxyAddress } from "./ProxyAddress.ts"
import { Registry } from "./Registry.ts"
import { Router } from "./Router.ts"
import { Runs } from "./Runs.ts"
import { Status } from "./Status.ts"
import * as Store from "./Store.ts"
import { Supervisor } from "./Supervisor.ts"
import { Tenants } from "./Tenants.ts"
import { observability, type TelemetryTarget } from "./Telemetry.ts"
import { Worktrees } from "./Worktrees.ts"

export type DaemonOptions = {
  readonly socket: string
  readonly stateFile: string
  readonly traefikDir: string
  readonly upstreamHost: string
  readonly proxyPort: Option.Option<Port>
  readonly httpPort: Port
  readonly httpPortFile: string
  readonly dashboardDir: string
  readonly domain: string
  readonly version: string
  readonly startupConcurrency: number
  readonly proxyMode: "docker" | "binary"
  readonly telemetry: TelemetryTarget | undefined
  readonly hostsFile: string | undefined
}

const forwardTelemetry = Effect.fn("Daemon.forwardTelemetry")(
  function* ({ url, headers }: TelemetryTarget) {
    const http = yield* HttpClient.HttpClient
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = new Uint8Array(yield* request.arrayBuffer)
    const target = `${url}${request.url.replace(/^\/otlp/, "")}`
    const contentType = request.headers["content-type"] ?? "application/json"

    const response = yield* http.execute(
      HttpClientRequest.post(target).pipe(HttpClientRequest.setHeaders(headers), HttpClientRequest.bodyUint8Array(body, contentType))
    )

    return HttpServerResponse.empty({ status: response.status })
  },
  Effect.orDie,
  Effect.withTracerEnabled(false)
)

const otlpProxy = (target: TelemetryTarget) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      yield* router.add("POST", "/otlp/*", forwardTelemetry(target).pipe(Effect.provideService(HttpClient.HttpClient, http)))
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

const dashboardServer = (options: DaemonOptions, dashboardUrl: string) =>
  HttpRouter.serve(
    Layer.mergeAll(
      dashboardOnly([dashboardUrl, `http://127.0.0.1:${options.httpPort}`, `http://localhost:${options.httpPort}`]),
      RpcServer.layer(ForkyardRpcs).pipe(Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" }))),
      options.telemetry ? otlpProxy(options.telemetry) : Layer.empty,
      HttpStaticServer.layer({ root: options.dashboardDir, spa: true, cacheControl: "no-store" })
    ),
    { disableLogger: true }
  ).pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(NodeHttpServer.layerServer(createServer, { port: options.httpPort, host: "127.0.0.1" })),
    Layer.provide(NodeHttpPlatform.layer),
    Layer.provide(Etag.layer)
  )

const advertiseHttpPort = (options: DaemonOptions) =>
  Layer.effectDiscard(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) =>
        Effect.acquireRelease(fs.writeFileString(options.httpPortFile, `${options.httpPort}\n`), () =>
          fs.remove(options.httpPortFile, { force: true }).pipe(Effect.ignore)
        )
      )
    )
  )

const cliServer = (options: DaemonOptions) =>
  RpcServer.layer(ForkyardRpcs).pipe(
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(NodeSocketServer.layer({ path: options.socket })),
    Layer.provide(Layer.succeed(References.UnhandledLogLevel, "Debug"))
  )

const otlpHeadersOf = (telemetry: TelemetryTarget | undefined) =>
  Object.entries(telemetry?.headers ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(",")

const telemetryLayer = (options: DaemonOptions) =>
  options.telemetry
    ? observability(options.telemetry, { serviceVersion: options.version, attributes: { "service.namespace": "forkyard" } })
    : Layer.empty

export const layer = (options: DaemonOptions) => {
  const dashboardHost = `forkyard.${options.domain}`
  const otlpUrl = options.telemetry?.url

  const records = Layer.mergeAll(
    Status.layer,
    FetchHttpClient.layer,
    Registry.layer,
    Runs.layer,
    Router.layer({ file: `${options.traefikDir}/forkyard.yml`, upstreamHost: options.upstreamHost, hostsFile: options.hostsFile })
  ).pipe(Layer.provideMerge(Store.layer(options.stateFile)), Layer.provideMerge(Platform.layer))

  const processes = Proc.layer({ otlpUrl }).pipe(Layer.provideMerge(records))

  const telemetry = telemetryLayer(options)

  const proxy = Proxy.layer({
    mode: options.proxyMode,
    traefikDir: options.traefikDir,
    port: options.proxyPort,
    dashboardHost,
    dashboardPort: options.httpPort
  }).pipe(Layer.provideMerge(processes))

  const worktrees = Worktrees.layer({ domain: options.domain }).pipe(
    Layer.provideMerge(
      Supervisor.layer({ startupConcurrency: options.startupConcurrency, otlpUrl, otlpHeaders: otlpHeadersOf(options.telemetry) })
    ),
    Layer.provideMerge(EnvResolver.layer),
    Layer.provideMerge(InfraManager.layer({ domain: options.domain })),
    Layer.provideMerge(Instances.layer),
    Layer.provideMerge(Tenants.layer),
    Layer.provideMerge(Sharing.layer)
  )

  const servers = Layer.unwrap(
    ProxyAddress.useSync((address) => {
      const dashboardUrl = address.url(dashboardHost)
      return Layer.mergeAll(
        Layer.effectDiscard(Effect.logInfo(`forkyard on ${options.socket}, dashboard at ${dashboardUrl}`)),
        cliServer(options),
        dashboardServer(options, dashboardUrl),
        advertiseHttpPort(options)
      ).pipe(Layer.provide(Api.layer({ dashboardUrl })))
    })
  )

  return servers.pipe(
    Layer.provide(ProcessUsage.layer),
    Layer.provideMerge(worktrees),
    Layer.provide(telemetry),
    Layer.provideMerge(proxy),
    Layer.provide(DaemonLog.logging)
  )
}
