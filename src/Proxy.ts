import { Effect, Layer, Option, Path, Schema } from "effect"
import { Port } from "./Ids.ts"
import { dockerContainer, forkyardName, removeContainer } from "./infra/Shared.ts"
import { toolsFor } from "./InfraManager.ts"
import { allocatePort, takenOnLoopback } from "./Ports.ts"
import { Proc } from "./Proc.ts"
import { ProxyAddress } from "./ProxyAddress.ts"
import { Os } from "./platform/Os.ts"
import { Router } from "./Router.ts"
import { cmd, type InfraProcess, proxiedUrl } from "./Stack.ts"

const traefikArgs = (port: number, dynamicDir: string) => [
  `--entrypoints.web.address=:${port}`,
  `--providers.file.directory=${dynamicDir}`,
  "--providers.file.watch=true",
  "--metrics.prometheus=true",
  "--metrics.prometheus.entryPoint=web",
  "--metrics.prometheus.addRoutersLabels=true",
  "--metrics.prometheus.manualRouting=true"
]

const preferredPorts = [80, 8080].map((port) => Port.make(port))

export class ProxyPortTaken extends Schema.TaggedError<ProxyPortTaken, { readonly brand: unique symbol }>()("ProxyPortTaken", {
  message: Schema.String
}) {}

const reportExit = (proxy: InfraProcess) =>
  proxy.exited.pipe(
    Effect.flatMap((code) => proxy.output.pipe(Effect.map((output) => ({ code, output })))),
    Effect.flatMap(({ code, output }) =>
      Effect.logError(`the proxy exited with ${code}, so worktree URLs stop working until forkyard restarts:\n${output.join("\n")}`)
    ),
    Effect.forkScoped
  )

type Options = {
  readonly mode: "docker" | "binary"
  readonly traefikDir: string
  readonly port: Option.Option<Port>
  readonly dashboardHost: string
  readonly dashboardPort: Port
}

const firstFree = (ports: ReadonlyArray<Port>, isFree: (port: Port) => Effect.Effect<boolean>): Effect.Effect<Option.Option<Port>> => {
  const [port, ...rest] = ports
  if (port === undefined) return Effect.succeedNone
  return isFree(port).pipe(Effect.flatMap((free) => (free ? Effect.succeedSome(port) : firstFree(rest, isFree))))
}

const choosePort = Effect.fn("Proxy.choosePort")(function* (options: Options, isFree: (port: Port) => Effect.Effect<boolean>) {
  if (Option.isSome(options.port)) {
    if (yield* isFree(options.port.value)) return options.port.value
    return yield* new ProxyPortTaken({
      message: `port ${options.port.value} is already in use by another program, so forkyard's proxy cannot serve its URLs there. Stop that program, or change FORKYARD_PROXY_PORT.`
    })
  }
  const preferred = yield* firstFree(preferredPorts, isFree)
  const port = Option.isSome(preferred) ? preferred.value : yield* allocatePort
  if (port !== preferredPorts[0]) yield* Effect.logWarning(`port 80 is in use by another program, so forkyard's URLs use port ${port}`)
  return port
})

export const layer = (options: Options) =>
  Layer.effect(
    ProxyAddress,
    Effect.gen(function* () {
      const proc = yield* Proc
      const os = yield* Os
      const router = yield* Router
      const path = yield* Path.Path
      const tools = toolsFor(proc, "forkyard")
      const container = (port: Port) => forkyardName("traefik", port)
      const removeOwnProxy = (port: Port) =>
        options.mode === "docker" ? container(port).pipe(Effect.flatMap((name) => removeContainer(tools, name))) : Effect.void
      const isFree = (port: Port) =>
        removeOwnProxy(port).pipe(
          Effect.andThen(takenOnLoopback(port)),
          Effect.map((taken) => !taken)
        )

      const port = yield* choosePort(options, isFree)
      const networking = os.dockerProxy(port)
      const metricsHost = `metrics.${options.dashboardHost}`
      yield* router.expose({ host: options.dashboardHost, port: options.dashboardPort })
      yield* router.expose({ host: metricsHost, port, builtIn: "prometheus@internal" })
      const proxy = yield* options.mode === "binary"
        ? tools.spawn({ name: "traefik", run: cmd("traefik", ...traefikArgs(port, path.resolve(options.traefikDir))), env: {} })
        : container(port).pipe(
            Effect.flatMap((name) =>
              dockerContainer(tools, {
                infra: "traefik",
                name,
                args: [
                  ...networking.args,
                  "-v",
                  `${path.resolve(options.traefikDir)}:/etc/traefik/dynamic`,
                  "traefik:v3",
                  ...traefikArgs(networking.listenPort(port), "/etc/traefik/dynamic")
                ]
              })
            )
          )
      yield* reportExit(proxy)
      yield* Effect.annotateCurrentSpan({ "server.port": port })
      return ProxyAddress.of({ port, url: (host) => proxiedUrl(host, port), metricsHost })
    }).pipe(Effect.withSpan("Proxy.start"))
  )
