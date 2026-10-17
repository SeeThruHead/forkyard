import { NodeRuntime } from "@effect/platform-node"
import { supplyConfigImports } from "./ConfigImports.ts"
import { Upgrade } from "./Upgrade.ts"
import { dashboardDir, defaultHome, packageVersion } from "./Package.ts"
import { Config, Effect, FileSystem, Layer, Path } from "effect"
import { availableParallelism } from "node:os"
import * as Daemon from "./Daemon.ts"
import { Port } from "./Ids.ts"
import * as Platform from "./Platform.ts"

export { defaultHome }

const settings = Config.all({
  proxyPort: Config.Port("FORKYARD_PROXY_PORT").pipe(Config.withDefault(80)),
  httpPort: Config.Port("FORKYARD_HTTP_PORT").pipe(Config.withDefault(4949)),
  maplePort: Config.Port("FORKYARD_MAPLE_PORT").pipe(Config.withDefault(14418)),
  startupConcurrency: Config.Int("FORKYARD_STARTUP_CONCURRENCY").pipe(Config.withDefault(availableParallelism())),
  supervised: Config.Boolean("FORKYARD_SUPERVISED").pipe(Config.withDefault(false)),
  upstreamHost: Config.String("FORKYARD_UPSTREAM_HOST").pipe(Config.withDefault("host.docker.internal")),
  dashboardDir: Config.String("FORKYARD_DASHBOARD_DIR").pipe(Config.withDefault(dashboardDir))
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
  version: packageVersion,
  startupConcurrency: config.startupConcurrency
})

const restartInPlace = () =>
  process.execve?.(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.env)

export const runDaemon = Effect.fn("runDaemon")(function* (home: string) {
  yield* Effect.sync(supplyConfigImports)
  const path = yield* Path.Path
  const config = yield* settings

  yield* survivePipeClose
  yield* prepareHome(home)

  const upgrade = Upgrade.layer({ supervised: config.supervised })
  const daemon = Daemon.layer(optionsFor(home, path, config)).pipe(Layer.provideMerge(upgrade))

  yield* Effect.scoped(
    Layer.build(daemon).pipe(
      Effect.flatMap((services) => Upgrade.use((upgrade) => upgrade.restartRequested).pipe(Effect.provide(services)))
    )
  )
  if (!config.supervised) yield* Effect.sync(restartInPlace)
}, Effect.provide(Platform.layer))

if (import.meta.main) runDaemon(process.argv[2] ?? defaultHome).pipe(NodeRuntime.runMain)
