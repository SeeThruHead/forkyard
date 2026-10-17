import { Context, Effect, Layer, PubSub, Record, Stream, SubscriptionRef } from "effect"
import type { LogLine, ServiceState, ServiceStatus, Snapshot, WorktreeStatus } from "./Model.ts"

export class Status extends Context.Service<Status, {
  readonly register: (worktree: Omit<WorktreeStatus, "services">) => Effect.Effect<void>
  readonly update: (worktree: string, service: string, patch: Partial<ServiceStatus> & Pick<ServiceStatus, "kind">) => Effect.Effect<void>
  readonly set: (worktree: string, service: string, state: ServiceState) => Effect.Effect<void>
  readonly clear: (worktree: string) => Effect.Effect<void>
  readonly snapshot: Effect.Effect<Snapshot>
  readonly changes: Stream.Stream<Snapshot>
  readonly log: (line: LogLine) => Effect.Effect<void>
  readonly logs: Stream.Stream<LogLine>
}>()("forkyard/Status") {
  static readonly layer = Layer.effect(
    Status,
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<Snapshot>({})
      const lines = yield* PubSub.sliding<LogLine>(4096)

      const patchService = (worktree: string, service: string, patch: (current: ServiceStatus | undefined) => ServiceStatus) =>
        SubscriptionRef.update(state, (all) => {
          const current = all[worktree]
          if (!current) return all
          return { ...all, [worktree]: { ...current, services: { ...current.services, [service]: patch(current.services[service]) } } }
        })

      const withoutDetail = (current: ServiceStatus | undefined) => {
        if (!current) return {}
        const { detail: _detail, ...rest } = current
        return rest
      }

      const clearsDetail = (patch: Partial<ServiceStatus>) => patch.detail === undefined && (patch.state === "ready" || patch.state === "starting")

      const update = (worktree: string, service: string, patch: Partial<ServiceStatus> & Pick<ServiceStatus, "kind">) =>
        patchService(worktree, service, (current) => ({ state: "waiting", ...(clearsDetail(patch) ? withoutDetail(current) : current), ...patch }))

      const set = (worktree: string, service: string, next: ServiceState) =>
        patchService(worktree, service, (current) => ({ kind: "worker", ...current, state: next }))

      return Status.of({
        register: (worktree) => SubscriptionRef.update(state, Record.set(worktree.id, { ...worktree, services: {} })),
        update,
        set,
        clear: (worktree) => SubscriptionRef.update(state, Record.remove(worktree)),
        snapshot: SubscriptionRef.get(state),
        changes: SubscriptionRef.changes(state),
        log: (line) => PubSub.publish(lines, line).pipe(Effect.asVoid),
        logs: Stream.fromPubSub(lines)
      })
    })
  )
}
