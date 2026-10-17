import { Context, Effect, Layer, PubSub, Record, type Scope, Stream, SubscriptionRef } from "effect"
import type { InfraName, ServiceName, WorktreeId } from "./Ids.ts"
import type { InfraView, LogLine, ServiceState, ServiceView, Snapshot, WorktreeView } from "./Model.ts"

type WorktreeHeader = Omit<WorktreeView, "services" | "infra">

const withState = (view: ServiceView, state: ServiceState): ServiceView => ({ ...view, state })

export class Status extends Context.Service<
  Status,
  {
    readonly register: (worktree: WorktreeHeader) => Effect.Effect<void>
    readonly service: (id: WorktreeId, name: ServiceName, view: ServiceView) => Effect.Effect<void>
    readonly serviceState: (id: WorktreeId, name: ServiceName, state: ServiceState) => Effect.Effect<void>
    readonly infra: (id: WorktreeId, name: InfraName, view: InfraView) => Effect.Effect<void>
    readonly clear: (id: WorktreeId) => Effect.Effect<void>
    readonly snapshot: Effect.Effect<Snapshot>
    readonly changes: Stream.Stream<Snapshot>
    readonly log: (line: LogLine) => Effect.Effect<void>
    readonly logs: Stream.Stream<LogLine>
    readonly followLogs: Effect.Effect<Stream.Stream<LogLine>, never, Scope.Scope>
  }
>()("forkyard/Status") {
  static readonly layer = Layer.effect(
    Status,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<Snapshot>({})
      const lines = yield* PubSub.sliding<LogLine>(4096)

      const updateWorktree = (id: WorktreeId, update: (worktree: WorktreeView) => WorktreeView) =>
        SubscriptionRef.update(state, (all) => {
          const worktree = all[id]
          if (!worktree) return all
          return { ...all, [id]: update(worktree) }
        })

      const service = (id: WorktreeId, name: ServiceName, view: ServiceView) =>
        updateWorktree(id, (worktree) => ({ ...worktree, services: { ...worktree.services, [name]: view } }))

      const serviceState = (id: WorktreeId, name: ServiceName, next: ServiceState) =>
        updateWorktree(id, (worktree) => {
          const current = worktree.services[name]
          if (!current) return worktree
          return { ...worktree, services: { ...worktree.services, [name]: withState(current, next) } }
        })

      const infra = (id: WorktreeId, name: InfraName, view: InfraView) =>
        updateWorktree(id, (worktree) => ({ ...worktree, infra: { ...worktree.infra, [name]: view } }))

      return Status.of({
        register: (worktree) => SubscriptionRef.update(state, Record.set(worktree.id, { ...worktree, services: {}, infra: {} })),
        service,
        serviceState,
        infra,
        clear: (id) => SubscriptionRef.update(state, Record.remove(id)),
        snapshot: SubscriptionRef.get(state),
        changes: SubscriptionRef.changes(state),
        log: (line) => PubSub.publish(lines, line).pipe(Effect.asVoid),
        logs: Stream.fromPubSub(lines),
        followLogs: PubSub.subscribe(lines).pipe(Effect.map(Stream.fromSubscription))
      })
    })
  )
}
