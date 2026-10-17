import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, LayerMap, Predicate, Schedule, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

class CurrentWorktree extends Context.Service<CurrentWorktree, { readonly slug: string }>()("b/CurrentWorktree") {}

class Postgres extends Context.Service<Postgres, { readonly url: string }>()("b/Postgres") {}
class Temporal extends Context.Service<Temporal, { readonly address: string }>()("b/Temporal") {}
class Api extends Context.Service<Api, { readonly url: string }>()("b/Api") {}
class CoreWorkers extends Context.Service<CoreWorkers, { readonly pid: number }>()("b/CoreWorkers") {}

const supervised = Effect.fn("supervised")(function*(name: string, env: Record<string, string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const once = spawner
    .spawn(ChildProcess.make("pnpm", ["--filter", name, "dev"], { env, extendEnv: true, detached: true }))
    .pipe(Effect.flatMap((handle) => handle.exitCode), Effect.scoped)
  yield* once.pipe(Effect.repeat(Schedule.spaced("500 millis")), Effect.forkScoped)
})

const PostgresShared = Layer.effect(
  Postgres,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* spawner.spawn(ChildProcess.make("docker", ["compose", "up", "postgres"]))
    return Postgres.of({ url: "postgres://postgres@127.0.0.1:5432" })
  })
)

const TemporalPerWorktree = Layer.effect(
  Temporal,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("temporal", ["server", "start-dev", "--port", "0"]))
    const address = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => /Temporal server: (\S+)/.exec(line)?.[1]),
      Stream.filter(Predicate.isNotUndefined),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption)
    )
    return Temporal.of({ address })
  })
)

const ApiLive = Layer.effect(
  Api,
  Effect.gen(function*() {
    const { slug } = yield* CurrentWorktree
    const postgres = yield* Postgres
    const temporal = yield* Temporal
    yield* supervised("@shop/api", {
      DATABASE_URL: `${postgres.url}/shop_${slug}`,
      TEMPORAL_ADDRESS: temporal.address
    })
    return Api.of({ url: `http://api.${slug}.localhost` })
  })
)

const CoreWorkersLive = Layer.effect(
  CoreWorkers,
  Effect.gen(function*() {
    const { slug } = yield* CurrentWorktree
    const api = yield* Api
    const temporal = yield* Temporal
    yield* supervised("@shop/workers", { API_URL: api.url, TEMPORAL_ADDRESS: temporal.address })
    return CoreWorkers.of({ pid: 0 })
  })
)

const worktreeStack = (slug: string) =>
  CoreWorkersLive.pipe(
    Layer.provideMerge(ApiLive),
    Layer.provideMerge(TemporalPerWorktree),
    Layer.provide(Layer.succeed(CurrentWorktree, { slug }))
  )

export class Worktrees extends LayerMap.Service<Worktrees>()("b/Worktrees", {
  lookup: worktreeStack,
  dependencies: [PostgresShared.pipe(Layer.provide(NodeServices.layer)), NodeServices.layer],
  idleTimeToLive: "5 seconds"
}) {}

export const up = (slug: string) =>
  Effect.gen(function*() {
    const api = yield* Api
    yield* Effect.logInfo(`${slug} is up at ${api.url}`)
    return yield* Effect.never
  }).pipe(Effect.provide(Worktrees.get(slug)))
