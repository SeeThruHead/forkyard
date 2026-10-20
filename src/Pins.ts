import { Context, Effect, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { SqlClient } from "effect/sql"
import type { WorktreeId } from "./Ids.ts"

const PinRow = Schema.Struct({ worktree: Schema.String, service: Schema.String })

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(PinRow))

type PinMap = Readonly<Record<string, ReadonlyArray<string>>>

const grouped = (rows: ReadonlyArray<typeof PinRow.Type>): PinMap =>
  Object.fromEntries(
    [...new Set(rows.map((row) => row.worktree))].map((worktree) => [
      worktree,
      rows.filter((row) => row.worktree === worktree).map((row) => row.service)
    ])
  )

const pinsIn = (all: PinMap, id: WorktreeId): ReadonlySet<string> => new Set(all[id] ?? [])

export class Pins extends Context.Service<
  Pins,
  {
    readonly pin: (id: WorktreeId, service: string) => Effect.Effect<void>
    readonly unpin: (id: WorktreeId, service: string) => Effect.Effect<void>
    readonly of: (id: WorktreeId) => Effect.Effect<ReadonlySet<string>>
    readonly changes: (id: WorktreeId) => Stream.Stream<ReadonlySet<string>>
  }
>()("forkyard/Pins") {
  static readonly layer = Layer.effect(
    Pins,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const load = sql`SELECT worktree, service FROM pins`.pipe(Effect.flatMap(decodeRows), Effect.map(grouped), Effect.orDie)
      const state = yield* SubscriptionRef.make(yield* load)
      const reload = load.pipe(Effect.flatMap((all) => SubscriptionRef.set(state, all)))

      const pin = (id: WorktreeId, service: string) =>
        sql`INSERT OR IGNORE INTO pins (worktree, service) VALUES (${id}, ${service})`.pipe(Effect.orDie, Effect.andThen(reload))

      const unpin = (id: WorktreeId, service: string) =>
        sql`DELETE FROM pins WHERE worktree = ${id} AND service = ${service}`.pipe(Effect.orDie, Effect.andThen(reload))

      const of = (id: WorktreeId) => SubscriptionRef.get(state).pipe(Effect.map((all) => pinsIn(all, id)))

      const changes = (id: WorktreeId) =>
        SubscriptionRef.changes(state).pipe(
          Stream.map((all) => pinsIn(all, id)),
          Stream.changesWith((a, b) => a.size === b.size && [...a].every((name) => b.has(name)))
        )

      return Pins.of({ pin, unpin, of, changes })
    })
  )
}
