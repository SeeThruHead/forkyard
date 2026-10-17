import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cron, Effect, FiberHandle, Layer, Option, Schema } from "effect"
import { ClusterCron, ClusterWorkflowEngine, Entity, SingleRunner } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { Activity, Workflow } from "effect/workflow"

const Up = Rpc.make("Up", { payload: { root: Schema.String } })
const Down = Rpc.make("Down")
const Status = Rpc.make("Status", { success: Schema.Literals(["up", "down"]) })

export const Worktree = Entity.make("Worktree", [Up, Down, Status])

declare const superviseStack: (slug: string, root: string) => Effect.Effect<never>

export const WorktreeLive = Worktree.toLayer(
  Effect.gen(function* () {
    const address = yield* Entity.CurrentAddress
    const stack = yield* FiberHandle.make()
    return Worktree.of({
      Up: ({ payload }) =>
        FiberHandle.run(stack, superviseStack(address.entityId, payload.root), { onlyIfMissing: true }).pipe(Effect.asVoid),
      Down: () => FiberHandle.clear(stack),
      Status: () => FiberHandle.get(stack).pipe(Effect.map(Option.match({ onNone: () => "down" as const, onSome: () => "up" as const })))
    })
  }),
  { maxIdleTime: "12 hours" }
)

export class RefreshFailed extends Schema.TaggedError<RefreshFailed>()("RefreshFailed", { step: Schema.String }) {}

export const RefreshGolden = Workflow.make("RefreshGolden", {
  payload: { commit: Schema.String },
  idempotencyKey: ({ commit }) => commit,
  error: RefreshFailed
})

declare const sqlStep: (step: string) => Effect.Effect<void, RefreshFailed>

export const RefreshGoldenLive = RefreshGolden.toLayer(
  Effect.fn(function* (payload) {
    yield* Activity.make({ name: "clone", error: RefreshFailed, execute: sqlStep("clone golden to next") })
    yield* Activity.make({ name: "migrate", error: RefreshFailed, execute: sqlStep(`migrate next to ${payload.commit}`) })
    yield* Activity.make({ name: "swap", error: RefreshFailed, execute: sqlStep("rename next to golden") })
  })
)

declare const mainMigrationsCommit: Effect.Effect<string>

export const RefreshEvery15Minutes = ClusterCron.make({
  name: "golden-refresh",
  cron: Cron.parseUnsafe("*/15 * * * *"),
  execute: mainMigrationsCommit.pipe(
    Effect.flatMap((commit) => RefreshGolden.execute({ commit })),
    Effect.catch((error) => Effect.logWarning("golden refresh failed, keeping current golden", error))
  )
})

export const DaemonLive = Layer.mergeAll(WorktreeLive, RefreshGoldenLive, RefreshEvery15Minutes).pipe(
  Layer.provide(ClusterWorkflowEngine.layer),
  Layer.provideMerge(SingleRunner.layer({ runnerStorage: "sql" })),
  Layer.provide(SqliteClient.layer({ filename: "forkyard.sqlite" })),
  Layer.provide(NodeServices.layer)
)
