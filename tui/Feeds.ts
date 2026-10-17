import { Effect, FiberMap, Ref, Stream } from "effect"
import { ForkyardClient } from "../src/Client.ts"
import { ownerOfInfra, type RunId, type WorktreeId } from "../src/Ids.ts"
import { type InfraView, runOf, type ServiceView, type Snapshot, type UsageMap, type WorktreeView } from "../src/Model.ts"

export type Line = { readonly key: string; readonly at: number; readonly text: string }

export type Logs = { readonly byKey: Readonly<Record<string, ReadonlyArray<Line>>> }

export type LogAction = { readonly _tag: "Lines"; readonly key: string; readonly lines: ReadonlyArray<Line> } | { readonly _tag: "Reset" }

const keepPerService = 2000

export const emptyLogs: Logs = { byKey: {} }

export const logsReducer = (logs: Logs, action: LogAction): Logs => {
  if (action._tag === "Reset") return emptyLogs
  return { byKey: { ...logs.byKey, [action.key]: [...(logs.byKey[action.key] ?? []), ...action.lines].slice(-keepPerService) } }
}

export const keyOfInfra = (name: string) => `infra:${name}`

export const separator = (text: string) => text.startsWith("── ")

type LineSink = (key: string, lines: ReadonlyArray<Line>) => void

const followRun = (sink: LineSink, key: string, runId: RunId, label: string) =>
  ForkyardClient.use((forkyard) =>
    Effect.sync(() => sink(key, [{ key, at: Date.now(), text: `── ${label} ──` }])).pipe(
      Effect.andThen(
        forkyard.RunLog({ runId }).pipe(
          Stream.groupedWithin(500, "60 millis"),
          Stream.runForEach((chunk) =>
            Effect.sync(() =>
              sink(
                key,
                chunk.map((line) => ({ key, at: line.at, text: line.line }))
              )
            )
          )
        )
      )
    )
  )

const latestInfraRun = (name: string, instance: string) =>
  ForkyardClient.use((forkyard) => forkyard.Runs({ owner: ownerOfInfra(instance), service: name })).pipe(Effect.map((runs) => runs[0]))

export const reconnecting = <E, R>(feed: Effect.Effect<void, E, R>, events: { readonly start: () => void; readonly lost: () => void }) =>
  Effect.sync(events.start).pipe(
    Effect.andThen(feed),
    Effect.ignore,
    Effect.andThen(Effect.sync(events.lost)),
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever
  )

export const statusFeed = (onSnapshot: (snapshot: Snapshot) => void) =>
  ForkyardClient.use((forkyard) => forkyard.Status().pipe(Stream.runForEach((snapshot) => Effect.sync(() => onSnapshot(snapshot)))))

export const usageFeed = (onUsage: (usage: UsageMap) => void) =>
  ForkyardClient.use((forkyard) => forkyard.Usage().pipe(Stream.runForEach((usage) => Effect.sync(() => onUsage(usage)))))

export const daemonFeed = (sink: LineSink) =>
  ForkyardClient.use((forkyard) =>
    forkyard.DaemonLogs().pipe(
      Stream.groupedWithin(500, "60 millis"),
      Stream.runForEach((chunk) =>
        Effect.sync(() =>
          sink(
            "forkyard",
            chunk.map((line) => ({ key: "forkyard", at: line.at, text: `${line.level.padEnd(5)} ${line.message}` }))
          )
        )
      )
    )
  )

export const worktreeLogFeed = Effect.fn("Tui.worktreeLogFeed")(function* (id: WorktreeId, sink: LineSink) {
  const forkyard = yield* ForkyardClient
  const followers = yield* FiberMap.make<string>()
  const following = yield* Ref.make<Readonly<Record<string, string>>>({})

  const startIfNew = (key: string, marker: string, start: Effect.Effect<void, unknown, ForkyardClient>) =>
    Ref.get(following).pipe(
      Effect.flatMap((current) => {
        if (current[key] === marker) return Effect.void
        return Ref.update(following, (all) => ({ ...all, [key]: marker })).pipe(
          Effect.andThen(FiberMap.run(followers, key, start.pipe(Effect.ignore)))
        )
      })
    )

  const followService = ([name, view]: readonly [string, ServiceView]) => {
    const run = runOf(view.state)
    if (!run) return Effect.void
    return startIfNew(name, String(run.runId), followRun(sink, name, run.runId, `run #${run.run}, pid ${run.pid}`))
  }

  const followInfra = ([name, view]: readonly [string, InfraView]) => {
    if (view._tag !== "InfraReady") return Effect.void
    const start = latestInfraRun(name, view.instance).pipe(
      Effect.flatMap((run) => (run ? followRun(sink, keyOfInfra(name), run.id, `${view.instance}, run #${run.n}`) : Effect.void))
    )
    return startIfNew(keyOfInfra(name), view.instance, start)
  }

  const follow = (worktree: WorktreeView | undefined) => {
    if (!worktree) return Effect.void
    return Effect.forEach(Object.entries(worktree.infra), followInfra, { discard: true }).pipe(
      Effect.andThen(Effect.forEach(Object.entries(worktree.services), followService, { discard: true }))
    )
  }

  yield* forkyard.Status().pipe(Stream.runForEach((snapshot) => follow(snapshot[id])))
}, Effect.scoped)
