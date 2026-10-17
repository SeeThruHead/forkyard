import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Atom, AtomRegistry } from "effect/reactivity"

const ServiceConfig = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String)
})
type ServiceConfig = typeof ServiceConfig.Type

const StackConfig = Schema.Record(Schema.String, ServiceConfig)
type StackConfig = typeof StackConfig.Type

export const stackConfig = Atom.make<StackConfig>({})

export const fingerprint = Atom.family((name: string) => Atom.make((get) => JSON.stringify(get(stackConfig)[name] ?? null)))

const devRuntime = Atom.runtime(NodeServices.layer)

export const service = Atom.family((name: string) =>
  devRuntime.atom((get) =>
    Effect.gen(function* () {
      get(fingerprint(name))
      const config = get.once(stackConfig)[name]
      if (!config) return "absent" as const
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(config.command, [...config.args], { env: config.env, extendEnv: true, detached: true })
      )
      yield* Effect.logInfo(`${name} started as ${handle.pid}`)
      return "running" as const
    })
  )
)

export const watchStackFile = Effect.fn("watchStackFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const registry = yield* AtomRegistry.AtomRegistry
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StackConfig))
  const load = fs.readFileString(file).pipe(
    Effect.flatMap(decode),
    Effect.tap((config) => Effect.sync(() => registry.set(stackConfig, config))),
    Effect.catch((error) => Effect.logWarning("stack file rejected, keeping previous config", error))
  )
  yield* load
  yield* fs.watch(file).pipe(
    Stream.debounce("100 millis"),
    Stream.runForEach(() => load),
    Effect.forkScoped
  )
})

export const mountServices = Effect.fn("mountServices")(function* (names: ReadonlyArray<string>) {
  const registry = yield* AtomRegistry.AtomRegistry
  yield* Effect.forEach(names, (name) => AtomRegistry.mount(registry, service(name)), { discard: true })
})
