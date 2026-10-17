import { NodeRuntime } from "@effect/platform-node"
import { Config, Effect, FileSystem, Layer, Path } from "effect"
import { fileURLToPath } from "node:url"
import * as Daemon from "./Daemon.ts"
import * as Platform from "./Platform.ts"

export const defaultHome = fileURLToPath(new URL("../run", import.meta.url))

const survivePipeClose = Effect.sync(() => {
  process.stdout.on("error", () => undefined)
  process.stderr.on("error", () => undefined)
})

export const runDaemon = Effect.fn("runDaemon")(function*(home: string) {
    yield* survivePipeClose
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.join(home, "traefik"), { recursive: true })
    const socket = path.join(home, "forkyard.sock")
    yield* fs.remove(socket).pipe(Effect.ignore)
    const proxyPort = yield* Config.Port("FORKYARD_PROXY_PORT").pipe(Config.withDefault(80))
    const httpPort = yield* Config.Port("FORKYARD_HTTP_PORT").pipe(Config.withDefault(4949))
    const maplePort = yield* Config.Port("FORKYARD_MAPLE_PORT").pipe(Config.withDefault(14418))
    const upstreamHost = yield* Config.String("FORKYARD_UPSTREAM_HOST").pipe(Config.withDefault("host.docker.internal"))
    const dashboardDir = yield* Config.String("FORKYARD_DASHBOARD_DIR").pipe(
      Config.withDefault(fileURLToPath(new URL("../dashboard/dist", import.meta.url)))
    )
    const suffix = proxyPort === 80 ? "" : `:${proxyPort}`
    yield* Effect.logInfo(`forkyard on ${socket}, dashboard at http://forkyard.localhost${suffix}, traces at http://maple.localhost${suffix}`)
    return yield* Layer.launch(
      Daemon.layer({
        socket,
        stateFile: path.join(home, "forkyard.sqlite"),
        traefikDir: path.join(home, "traefik"),
        upstreamHost,
        proxyPort,
        httpPort,
        dashboardDir,
        domain: "localhost",
        maplePort,
        version: "0.1.0"
      })
    )
  }, Effect.provide(Platform.layer))

if (import.meta.main) runDaemon(process.argv[2] ?? defaultHome).pipe(NodeRuntime.runMain)
