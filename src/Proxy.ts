import { Effect, Layer, Path } from "effect"
import type { Port } from "./Ids.ts"
import { dockerContainer } from "./infra/Shared.ts"
import { toolsFor } from "./InfraManager.ts"
import { Proc } from "./Proc.ts"
import { Router } from "./Router.ts"

export const layer = (options: {
  readonly traefikDir: string
  readonly port: Port
  readonly dashboardHost: string
  readonly dashboardPort: Port
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const proc = yield* Proc
      const router = yield* Router
      const path = yield* Path.Path
      yield* router.expose({ host: options.dashboardHost, port: options.dashboardPort })
      yield* dockerContainer(toolsFor(proc, "forkyard"), {
        infra: "traefik",
        name: `forkyard-traefik-${options.port}`,
        args: [
          "-p",
          `${options.port}:80`,
          "-v",
          `${path.resolve(options.traefikDir)}:/etc/traefik/dynamic`,
          "traefik:v3",
          "--entrypoints.web.address=:80",
          "--providers.file.directory=/etc/traefik/dynamic",
          "--providers.file.watch=true"
        ]
      }).pipe(Effect.orDie)
    }).pipe(Effect.withSpan("Proxy.start", { attributes: { "server.port": options.port } }))
  )
