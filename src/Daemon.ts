import { NodeHttpPlatform, NodeHttpServer, NodeSocketServer } from "@effect/platform-node"
import { Clock, Effect, FiberMap, Latch, Layer, Metric, Path, Record, References, Stream } from "effect"
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
import { InfraManager } from "./InfraManager.ts"
import * as Metrics from "./Metrics.ts"
import * as Platform from "./Platform.ts"
import { Ports } from "./Ports.ts"
import { Proc } from "./Proc.ts"
import { ForkyardError, ForkyardRpcs } from "./Protocol.ts"
import * as Proxy from "./Proxy.ts"
import { type DesiredWorktree, Registry } from "./Registry.ts"
import { Router } from "./Router.ts"
import { Runs } from "./Runs.ts"
import type { Stack, Worktree } from "./Stack.ts"
import { Status } from "./Status.ts"
import * as Store from "./Store.ts"
import { Supervisor } from "./Supervisor.ts"
import { Maple, observability } from "./Telemetry.ts"

export type DaemonOptions = {
  readonly socket: string
  readonly stateFile: string
  readonly traefikDir: string
  readonly upstreamHost: string
  readonly proxyPort: number
  readonly httpPort: number
  readonly dashboardDir: string
  readonly domain: string
  readonly maplePort: number
  readonly version: string
}

const loadStack = Effect.fn("Daemon.loadStack")(function*(stackFile: string) {
  yield* Effect.annotateCurrentSpan({ "forkyard.stack_file": stackFile })
  const version = yield* Clock.currentTimeMillis
  return yield* Effect.tryPromise({
    try: () => import(`${stackFile}?t=${version}`).then((module: { readonly default: Stack }) => module.default),
    catch: (cause) => new ForkyardError({ message: `cannot load ${stackFile}: ${String(cause)}` })
  })
})

const branchSlug = (branch: string) => branch.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")

const Handlers = (options: DaemonOptions) =>
  ForkyardRpcs.toLayer(
    Effect.gen(function*() {
      const supervisor = yield* Supervisor
      const status = yield* Status
      const registry = yield* Registry
      const runs = yield* Runs
      const router = yield* Router
      const infra = yield* InfraManager
      const path = yield* Path.Path
      const worktrees = yield* FiberMap.make<string>()
      const booted = yield* Latch.make(false)

      const recordRunning = FiberMap.size(worktrees).pipe(Effect.flatMap((count) => Metric.update(Metrics.worktreesRunning, count)))

      const up = Effect.fn("Daemon.up")(function*(desired: { readonly root: string; readonly branch: string; readonly stackFile: string }) {
        yield* Effect.annotateCurrentSpan({ "forkyard.root": desired.root, "forkyard.branch": desired.branch })
        const stack = yield* loadStack(desired.stackFile)
        const id = `${branchSlug(desired.branch)}.${stack.name}`
        const worktree: Worktree = {
          id,
          project: stack.name,
          branch: branchSlug(desired.branch),
          root: desired.root,
          domain: `${id}.${options.domain}`,
          proxyPort: options.proxyPort
        }
        const row: DesiredWorktree = { slug: id, root: desired.root, branch: desired.branch, stack_file: desired.stackFile }
        yield* registry.desire(row, "up")
        if (yield* FiberMap.has(worktrees, id)) return { id }
        yield* status.register({ id, project: stack.name, branch: worktree.branch, root: desired.root })
        yield* FiberMap.run(worktrees, id, { onlyIfMissing: true })(
          supervisor.run(stack, worktree).pipe(
            Effect.scoped,
            Effect.tapCause((cause) => Effect.logError(`worktree ${id} stopped`, cause)),
            Effect.ensuring(status.clear(id)),
            Effect.ensuring(recordRunning)
          )
        )
        yield* recordRunning
        yield* Effect.annotateCurrentSpan({ "forkyard.worktree": id })
        return { id }
      })

      yield* registry.desiredUp.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => up({ root: row.root, branch: row.branch, stackFile: row.stack_file }).pipe(Effect.ignore), {
            discard: true
          })
        )
      )
      yield* Latch.open(booted)

      const existingRun = (runId: number) => runs.lines(runId)

      return ForkyardRpcs.of({
        Up: ({ root, branch, stackFile }) => Latch.whenOpen(booted, up({ root, branch, stackFile: stackFile ?? path.join(root, "forkyard.config.ts") })),
        Down: Effect.fn("Daemon.down")(function*({ id }) {
          yield* Effect.annotateCurrentSpan({ "forkyard.worktree": id })
          yield* registry.desire({ slug: id, root: "", branch: "", stack_file: "" }, "down")
          yield* FiberMap.remove(worktrees, id)
          yield* recordRunning
        }),
        Status: () => status.changes,
        Logs: ({ id }) => status.logs.pipe(Stream.filter((line) => line.worktree === id)),
        Env: ({ id, service }) =>
          supervisor.envOf(id, service).pipe(
            Effect.flatMap((env) => (env ? Effect.succeed(env) : Effect.fail(new ForkyardError({ message: `${id}/${service} has no resolved env yet` }))))
          ),
        Restart: ({ id, service }) => supervisor.restart(id, service),
        Runs: ({ id, service }) => runs.list(id, service),
        RunLog: ({ runId }) =>
          Stream.unwrap(
            Effect.gen(function*() {
              const live = status.logs.pipe(
                Stream.filter((line) => line.runId === runId),
                Stream.map((line) => ({ runId: line.runId, seq: line.seq, at: line.at, line: line.line }))
              )
              const history = yield* existingRun(runId)
              if (yield* runs.ended(runId)) return Stream.fromIterable(history)
              const last = history.at(-1)?.seq ?? -1
              return Stream.fromIterable(history).pipe(Stream.concat(live.pipe(Stream.filter((line) => line.seq > last))))
            })
          ),
        Routes: () => router.routes.pipe(Effect.map(Record.map((route) => route.port))),
        Infra: () => infra.running
      })
    })
  )

const otlpProxy = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const maple = yield* Maple
    const http = yield* HttpClient.HttpClient
    yield* router.add(
      "POST",
      "/otlp/*",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = new Uint8Array(yield* request.arrayBuffer)
        const target = `${maple.otlpUrl}${request.url.replace(/^\/otlp/, "")}`
        const response = yield* http.execute(
          HttpClientRequest.post(target).pipe(HttpClientRequest.bodyUint8Array(body, request.headers["content-type"] ?? "application/json"))
        )
        return HttpServerResponse.empty({ status: response.status })
      }).pipe(Effect.orDie, Effect.withTracerEnabled(false))
    )
  })
)

const dashboard = (options: DaemonOptions) =>
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

const cli = (options: DaemonOptions) =>
  RpcServer.layer(ForkyardRpcs).pipe(
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(NodeSocketServer.layer({ path: options.socket })),
    Layer.provide(Layer.succeed(References.UnhandledLogLevel, "Debug"))
  )

export const layer = (options: DaemonOptions) => {
  const otlpUrl = `http://127.0.0.1:${options.maplePort}`
  const base = Layer.mergeAll(
    Status.layer,
    Ports.layer,
    FetchHttpClient.layer,
    Registry.layer,
    Runs.layer,
    Router.layer({ file: `${options.traefikDir}/forkyard.yml`, upstreamHost: options.upstreamHost })
  ).pipe(Layer.provideMerge(Store.layer(options.stateFile)), Layer.provideMerge(Platform.layer))
  const processes = Proc.layer({ otlpUrl }).pipe(Layer.provideMerge(base))
  const telemetry = observability({ serviceVersion: options.version, attributes: { "service.namespace": "forkyard" } }).pipe(
    Layer.provideMerge(Maple.layer({ port: options.maplePort, host: `maple.${options.domain}`, proxyPort: options.proxyPort }))
  )
  const supervision = Supervisor.layer({ startupConcurrency: 6, otlpUrl }).pipe(
    Layer.provideMerge(InfraManager.layer({ domain: options.domain, proxyPort: options.proxyPort }))
  )
  const proxy = Proxy.layer({
    traefikDir: options.traefikDir,
    port: options.proxyPort,
    dashboardHost: `forkyard.${options.domain}`,
    dashboardPort: options.httpPort
  })
  const app = Layer.mergeAll(cli(options), dashboard(options), proxy).pipe(
    Layer.provide(Handlers(options)),
    Layer.provideMerge(supervision)
  )
  return app.pipe(Layer.provide(telemetry), Layer.provideMerge(processes))
}
