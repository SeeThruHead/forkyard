import { Effect, Layer, Path } from "effect"
import type { Port } from "./Ids.ts"
import { dockerContainer, forkyardName } from "./infra/Shared.ts"
import { toolsFor } from "./InfraManager.ts"
import { Proc } from "./Proc.ts"
import { Os } from "./platform/Os.ts"
import { Router } from "./Router.ts"
import { cmd } from "./Stack.ts"

const traefikArgs = (port: number, dynamicDir: string) => [
  `--entrypoints.web.address=:${port}`,
  `--providers.file.directory=${dynamicDir}`,
  "--providers.file.watch=true"
]

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
      yield* router.expose({ host: options.dashboardHost, port: options.dashboardPort })
      if (options.mode === "binary")
        return yield* toolsFor(proc, "forkyard")
          .spawn({ name: "traefik", run: cmd("traefik", ...traefikArgs(options.port, path.resolve(options.traefikDir))), env: {} })
          .pipe(Effect.orDie, Effect.asVoid)
      yield* dockerContainer(toolsFor(proc, "forkyard"), {
        infra: "traefik",
        name: forkyardName("traefik", options.port),
        args: [
          ...networking.args,
          "-v",
          `${path.resolve(options.traefikDir)}:/etc/traefik/dynamic`,
          "traefik:v3",
          ...traefikArgs(networking.listenPort(options.port), "/etc/traefik/dynamic")
        ]
      }).pipe(Effect.orDie)
    }).pipe(Effect.withSpan("Proxy.start", { attributes: { "server.port": options.port } }))
  )
