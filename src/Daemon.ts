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
import { Maple, observability } from "./Telemetry.ts"
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
}

const forwardToMaple = Effect.fn("Daemon.forwardToMaple")(
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

const otlpProxy = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const maple = yield* Maple
    const http = yield* HttpClient.HttpClient

    yield* router.add("POST", "/otlp/*", forwardToMaple(maple.otlpUrl).pipe(Effect.provideService(HttpClient.HttpClient, http)))
  })
)

const dashboardServer = (options: DaemonOptions) =>
  HttpRouter.serve(
    Layer.mergeAll(
      RpcServer.layer(ForkyardRpcs).pipe(Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" }))),
      otlpProxy,
      HttpStaticServer.layer({ root: options.dashboardDir, spa: true })
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

export const layer = (options: DaemonOptions) => {
  const otlpUrl = `http://127.0.0.1:${options.maplePort}`

  const records = Layer.mergeAll(
    Status.layer,
    FetchHttpClient.layer,
    Registry.layer,
    Runs.layer,
    Router.layer({ file: `${options.traefikDir}/forkyard.yml`, upstreamHost: options.upstreamHost })
  ).pipe(Layer.provideMerge(Store.layer(options.stateFile)), Layer.provideMerge(Platform.layer))

  const processes = Proc.layer({ otlpUrl }).pipe(Layer.provideMerge(records))

  const telemetry = observability({ serviceVersion: options.version, attributes: { "service.namespace": "forkyard" } }).pipe(
    Layer.provideMerge(Maple.layer({ port: options.maplePort, host: `maple.${options.domain}`, proxyPort: options.proxyPort }))
  )

  const worktrees = Worktrees.layer({ domain: options.domain, proxyPort: options.proxyPort }).pipe(
    Layer.provideMerge(Supervisor.layer({ startupConcurrency: options.startupConcurrency, otlpUrl })),
    Layer.provideMerge(EnvResolver.layer),
    Layer.provideMerge(InfraManager.layer({ domain: options.domain, proxyPort: options.proxyPort }))
  )

  const announce = Layer.effectDiscard(
    Effect.logInfo(
      `forkyard on ${options.socket}, dashboard at http://forkyard.${options.domain}${options.proxyPort === 80 ? "" : `:${options.proxyPort}`}`
    )
  )

  const servers = Layer.mergeAll(
    announce,
    cliServer(options),
    dashboardServer(options),
    Proxy.layer({
      traefikDir: options.traefikDir,
      port: options.proxyPort,
      dashboardHost: `forkyard.${options.domain}`,
      dashboardPort: options.httpPort
    })
  )

  return servers.pipe(
    Layer.provide(Api.layer),
    Layer.provideMerge(worktrees),
    Layer.provide(telemetry),
    Layer.provideMerge(processes),
    Layer.provide(DaemonLog.logging)
  )
}
