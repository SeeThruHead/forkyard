import { Context, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Platform from "../../src/Platform.ts"
import { Proc, type SpawnError, type Spawned } from "../../src/Proc.ts"
import { InfraName, ownerOfWorktree, WorktreeId } from "../../src/Ids.ts"
import { Registry } from "../../src/Registry.ts"
import { InfraError, type InfraSpec, node } from "../../src/Stack.ts"

export const spawnWithoutScope = Effect.gen(function* () {
  const proc = yield* Proc
  // @ts-expect-error
  const unscoped: Effect.Effect<Spawned, SpawnError, never> = proc.spawn({
    owner: ownerOfWorktree(WorktreeId.make("wt-a.app")),
    service: "api",
    run: node("api.mjs"),
    env: {},
    cwd: "."
  })
  return unscoped
})

// @ts-expect-error
export const forgedHandle: Spawned = { pid: 1, exited: Effect.succeed(0) }

export const trackWithoutScope = Effect.gen(function* () {
  const registry = yield* Registry
  const tracked: Effect.Effect<void, never, never> = registry
    // @ts-expect-error
    .record({ pid: 1, worktree: "wt-a", service: "api" })
  return tracked
})

class Rogue extends Context.Service<Rogue, {}>()("check/Rogue") {}

const RogueLive = Layer.effect(
  Rogue,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* spawner.spawn(ChildProcess.make("sleep", ["60"]))
    return Rogue.of({})
  })
)

// @ts-expect-error
export const rogueDaemon: Effect.Effect<never, unknown, never> = Layer.launch(RogueLive.pipe(Layer.provide(Platform.layer)))

export const rogueInfra: InfraSpec = {
  name: InfraName.make("rogue"),
  scope: "shared",
  start: () =>
    // @ts-expect-error
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner
        .spawn(ChildProcess.make("postgres", []))
        .pipe(Effect.mapError((error) => new InfraError({ infra: "rogue", message: error.message })))
      return { port: 5432, env: {} }
    }),
  tenant: () => Effect.succeed({})
}
