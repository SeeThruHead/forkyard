import { Context, Effect, Layer, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { SqlClient } from "effect/sql"
import type { WorktreeId } from "./Ids.ts"

export type PinKind = "own" | "start"

const PinRow = Schema.Struct({ worktree: Schema.String, service: Schema.String, kind: Schema.Literals(["own", "start"]) })

type PinRow = typeof PinRow.Type

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(PinRow))

const namesIn = (rows: ReadonlyArray<PinRow>, id: WorktreeId, kind: PinKind): ReadonlySet<string> =>
  new Set(rows.filter((row) => row.worktree === id && row.kind === kind).map((row) => row.service))

const sameNames = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((name) => b.has(name))

export class Pins extends Context.Service<
  Pins,
  {
    readonly pin: (id: WorktreeId, service: string, kind: PinKind) => Effect.Effect<void>
    readonly unpin: (id: WorktreeId, service: string, kind: PinKind) => Effect.Effect<void>
    readonly changes: (id: WorktreeId, kind: PinKind) => Stream.Stream<ReadonlySet<string>>
  }
>()("forkyard/Pins") {
  static readonly layer = Layer.effect(
    Pins,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const load = sql`SELECT worktree, service, kind FROM pins`.pipe(Effect.flatMap(decodeRows), Effect.orDie)
      const state = yield* SubscriptionRef.make(yield* load)
      const writing = yield* Semaphore.make(1)
      const reload = load.pipe(Effect.flatMap((rows) => SubscriptionRef.set(state, rows)))
      const thenPublish = <E>(change: Effect.Effect<unknown, E>) =>
        change.pipe(Effect.orDie, Effect.andThen(reload), Semaphore.withPermit(writing))

      const pin = (id: WorktreeId, service: string, kind: PinKind) =>
        thenPublish(sql`INSERT OR IGNORE INTO pins (worktree, service, kind) VALUES (${id}, ${service}, ${kind})`)

      const unpin = (id: WorktreeId, service: string, kind: PinKind) =>
        thenPublish(sql`DELETE FROM pins WHERE worktree = ${id} AND service = ${service} AND kind = ${kind}`)

      const changes = (id: WorktreeId, kind: PinKind) =>
        SubscriptionRef.changes(state).pipe(
          Stream.map((rows) => namesIn(rows, id, kind)),
          Stream.changesWith(sameNames)
        )

      return Pins.of({ pin, unpin, changes })
    })
  )
}
