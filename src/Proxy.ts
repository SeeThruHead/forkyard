import { Effect, Layer, Path, Schema } from "effect"
import type { Port } from "./Ids.ts"
import { dockerContainer, forkyardName, removeContainer } from "./infra/Shared.ts"
import { toolsFor } from "./InfraManager.ts"
import { takenOnLoopback } from "./Ports.ts"
import { Proc } from "./Proc.ts"
import { Os } from "./platform/Os.ts"
import { Router } from "./Router.ts"
import { cmd, type InfraProcess } from "./Stack.ts"

const traefikArgs = (port: number, dynamicDir: string) => [
  `--entrypoints.web.address=:${port}`,
  `--providers.file.directory=${dynamicDir}`,
  "--providers.file.watch=true"
]

export class ProxyPortTaken extends Schema.TaggedError<ProxyPortTaken>()("ProxyPortTaken", { message: Schema.String }) {}

const requireFreePort = (port: Port) =>
  takenOnLoopback(port).pipe(
    Effect.flatMap((taken) =>
      taken
        ? Effect.fail(
            new ProxyPortTaken({
              message: `port ${port} is already in use by another program, so forkyard's proxy cannot serve its URLs there. Stop that program, or set FORKYARD_PROXY_PORT.`
            })
          )
        : Effect.void
    )
  )

const reportExit = (proxy: InfraProcess) =>
  proxy.exited.pipe(
    Effect.flatMap((code) => proxy.output.pipe(Effect.map((output) => ({ code, output })))),
    Effect.flatMap(({ code, output }) =>
      Effect.logError(`the proxy exited with ${code}, so worktree URLs stop working until forkyard restarts:\n${output.join("\n")}`)
    ),
    Effect.forkScoped
  )

export const layer = (options: {
  readonly mode: "docker" | "binary"
  readonly traefikDir: string
  readonly port: Port
  readonly dashboardHost: string
  readonly dashboardPort: Port
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const proc = yield* Proc
      const os = yield* Os
      const networking = os.dockerProxy(options.port)
      const router = yield* Router
      const path = yield* Path.Path
      const container = forkyardName("traefik", options.port)
      if (options.mode === "docker") yield* removeContainer(toolsFor(proc, "forkyard"), container)
      yield* requireFreePort(options.port)
      yield* router.expose({ host: options.dashboardHost, port: options.dashboardPort })
      const proxy = yield* options.mode === "binary"
        ? toolsFor(proc, "forkyard").spawn({
            name: "traefik",
            run: cmd("traefik", ...traefikArgs(options.port, path.resolve(options.traefikDir))),
            env: {}
          })
        : dockerContainer(toolsFor(proc, "forkyard"), {
            infra: "traefik",
            name: container,
            args: [
              ...networking.args,
              "-v",
              `${path.resolve(options.traefikDir)}:/etc/traefik/dynamic`,
              "traefik:v3",
              ...traefikArgs(networking.listenPort(options.port), "/etc/traefik/dynamic")
            ]
          })
      yield* reportExit(proxy)
    }).pipe(Effect.withSpan("Proxy.start", { attributes: { "server.port": options.port } }))
  )
