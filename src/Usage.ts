import { Context, Effect, Layer, Schedule, Stream, SubscriptionRef } from "effect"
import { runOf, type Snapshot, type UsageMap } from "./Model.ts"
import { Os, type ProcessRow } from "./platform/Os.ts"
import { Status } from "./Status.ts"

type Row = ProcessRow

type Usage = { readonly cpu: number; readonly rssKb: number }

const childrenOf = (rows: ReadonlyArray<Row>) =>
  rows.reduce<Readonly<Record<number, ReadonlyArray<Row>>>>((all, row) => ({ ...all, [row.ppid]: [...(all[row.ppid] ?? []), row] }), {})

const treeUsage = (row: Row, children: Readonly<Record<number, ReadonlyArray<Row>>>): Usage =>
  (children[row.pid] ?? []).reduce(
    (total, child) => {
      const usage = treeUsage(child, children)
      return { cpu: total.cpu + usage.cpu, rssKb: total.rssKb + usage.rssKb }
    },
    { cpu: row.cpu, rssKb: row.rssKb }
  )

export const usageOf = (rows: ReadonlyArray<Row>, pids: ReadonlyArray<number>): UsageMap => {
  const children = childrenOf(rows)
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  return Object.fromEntries(
    pids.flatMap((pid) => {
      const row = byPid.get(pid)
      return row ? [[String(pid), treeUsage(row, children)]] : []
    })
  )
}

const pidsOf = (snapshot: Snapshot) =>
  Object.values(snapshot).flatMap((worktree) =>
    Object.values(worktree.services).flatMap((view) => {
      const run = runOf(view.state)
      return run ? [run.pid] : []
    })
  )

export class ProcessUsage extends Context.Service<ProcessUsage, { readonly changes: Stream.Stream<UsageMap> }>()("forkyard/ProcessUsage") {
  static readonly layer = Layer.effect(
    ProcessUsage,
    Effect.gen(function* () {
      const os = yield* Os
      const status = yield* Status
      const latest = yield* SubscriptionRef.make<UsageMap>({})

      const sample = Effect.gen(function* () {
        const snapshot = yield* status.snapshot
        const pids = pidsOf(snapshot)
        const rows = yield* os.processTable
        yield* SubscriptionRef.set(latest, usageOf(rows, pids))
      })

      yield* sample.pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped)

      return ProcessUsage.of({ changes: SubscriptionRef.changes(latest) })
    })
  )
}
