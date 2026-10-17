import { NodeRuntime } from "@effect/platform-node"
import { Config, Effect, FileSystem, Layer, Path } from "effect"
import { fileURLToPath } from "node:url"
import * as Daemon from "./Daemon.ts"
import { Port } from "./Ids.ts"
import * as Platform from "./Platform.ts"

export const defaultHome = fileURLToPath(new URL("../run", import.meta.url))

const settings = Config.all({
  proxyPort: Config.Port("FORKYARD_PROXY_PORT").pipe(Config.withDefault(80)),
  httpPort: Config.Port("FORKYARD_HTTP_PORT").pipe(Config.withDefault(4949)),
  maplePort: Config.Port("FORKYARD_MAPLE_PORT").pipe(Config.withDefault(14418)),
  upstreamHost: Config.String("FORKYARD_UPSTREAM_HOST").pipe(Config.withDefault("host.docker.internal")),
  dashboardDir: Config.String("FORKYARD_DASHBOARD_DIR").pipe(
    Config.withDefault(fileURLToPath(new URL("../dashboard/dist", import.meta.url)))
  )
})

type Settings = typeof settings extends Config.Config<infer A> ? A : never

const survivePipeClose = Effect.sync(() => {
  process.stdout.on("error", () => undefined)
  process.stderr.on("error", () => undefined)
})

const prepareHome = Effect.fn("prepareHome")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  yield* fs.makeDirectory(path.join(home, "traefik"), { recursive: true })
  yield* fs.remove(path.join(home, "forkyard.sock"), { force: true })
})

const optionsFor = (home: string, path: Path.Path, config: Settings): Daemon.DaemonOptions => ({
  socket: path.join(home, "forkyard.sock"),
  stateFile: path.join(home, "forkyard.sqlite"),
  traefikDir: path.join(home, "traefik"),
  upstreamHost: config.upstreamHost,
  proxyPort: Port.make(config.proxyPort),
  httpPort: Port.make(config.httpPort),
  maplePort: Port.make(config.maplePort),
  dashboardDir: config.dashboardDir,
  domain: "localhost",
  version: "0.1.0"
})

export const runDaemon = Effect.fn("runDaemon")(function* (home: string) {
  const path = yield* Path.Path
  const config = yield* settings

  yield* survivePipeClose
  yield* prepareHome(home)

  return yield* Layer.launch(Daemon.layer(optionsFor(home, path, config)))
}, Effect.provide(Platform.layer))

if (import.meta.main) runDaemon(process.argv[2] ?? defaultHome).pipe(NodeRuntime.runMain)
