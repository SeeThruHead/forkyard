import { NodeRuntime } from "@effect/platform-node"
import { lookup } from "node:dns/promises"
import { access, constants } from "node:fs/promises"
import { supplyConfigImports } from "./ConfigImports.ts"
import { parseHeaders, type TelemetryTarget } from "./Telemetry.ts"
import { Os } from "./platform/Os.ts"
import { Upgrade } from "./Upgrade.ts"
import { dashboardDir, defaultHome, packageVersion } from "./Package.ts"
import { Config, Effect, FileSystem, Layer, Option, Path } from "effect"
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
  upstreamHost: Config.String("FORKYARD_UPSTREAM_HOST").pipe(Config.option),
  proxyMode: Config.Literals(["docker", "binary"], "FORKYARD_PROXY").pipe(Config.withDefault("docker" as const)),
  telemetry: Config.Boolean("FORKYARD_TELEMETRY").pipe(Config.withDefault(true)),
  otlpUrl: Config.String("FORKYARD_OTLP_URL").pipe(Config.option),
  otlpHeaders: Config.String("FORKYARD_OTLP_HEADERS").pipe(Config.withDefault("")),
  hostsFile: Config.String("FORKYARD_HOSTS_FILE").pipe(Config.option),
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
  const os = yield* Os

  yield* fs.makeDirectory(path.join(home, "traefik"), { recursive: true })
  yield* fs.remove(os.ipcPath(home), { force: true })
})

const localhostResolves = Effect.tryPromise(() => lookup("forkyard-probe.localhost")).pipe(
  Effect.as(true),
  Effect.orElseSucceed(() => false)
)

const writable = (file: string) =>
  Effect.tryPromise(() => access(file, constants.W_OK)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )

const chooseHostsFile = Effect.fn("chooseHostsFile")(function* (configured: Option.Option<string>) {
  const os = yield* Os
  if (Option.isSome(configured)) return configured.value
  if (yield* localhostResolves) return undefined
  if (yield* writable(os.hostsFile)) return os.hostsFile
  yield* Effect.logWarning(
    `names under .localhost do not resolve here and ${os.hostsFile} is not writable: services that call each other by their forkyard URLs will fail`
  )
  return undefined
})

const defaultUpstream = (mode: "docker" | "binary", os: Os["Service"]) => (mode === "binary" ? "127.0.0.1" : os.dockerUpstream)

const telemetryTarget = (config: Settings): TelemetryTarget => {
  if (!config.telemetry) return { _tag: "Off" }
  if (Option.isSome(config.otlpUrl)) return { _tag: "Remote", url: config.otlpUrl.value, headers: parseHeaders(config.otlpHeaders) }
  return { _tag: "Local" }
}

const optionsFor = (
  home: string,
  path: Path.Path,
  os: Os["Service"],
  config: Settings,
  hostsFile: string | undefined
): Daemon.DaemonOptions => ({
  hostsFile,
  socket: os.ipcPath(home),
  stateFile: path.join(home, "forkyard.sqlite"),
  traefikDir: path.join(home, "traefik"),
  upstreamHost: Option.getOrElse(config.upstreamHost, () => defaultUpstream(config.proxyMode, os)),
  proxyMode: config.proxyMode,
  telemetry: telemetryTarget(config),
  proxyPort: Port.make(config.proxyPort),
  httpPort: Port.make(config.httpPort),
  maplePort: Port.make(config.maplePort),
  dashboardDir: config.dashboardDir,
  domain: "localhost",
  version: packageVersion,
  startupConcurrency: config.startupConcurrency
})

export const runDaemon = Effect.fn("runDaemon")(function* (home: string) {
  yield* Effect.sync(supplyConfigImports)
  const path = yield* Path.Path
  const config = yield* settings

  yield* survivePipeClose
  yield* prepareHome(home)

  const upgrade = Upgrade.layer({ supervised: config.supervised })
  const daemon = Daemon.layer(optionsFor(home, path, yield* Os, config, yield* chooseHostsFile(config.hostsFile))).pipe(
    Layer.provideMerge(upgrade)
  )

  yield* Effect.scoped(
    Layer.build(daemon).pipe(
      Effect.flatMap((services) => Upgrade.use((upgrade) => upgrade.restartRequested).pipe(Effect.provide(services)))
    )
  )
  if (!config.supervised) yield* Os.use((os) => os.restartInPlace)
}, Effect.provide(Platform.layer))

if (import.meta.main) runDaemon(process.argv[2] ?? defaultHome).pipe(NodeRuntime.runMain)
