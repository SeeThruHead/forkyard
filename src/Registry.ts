import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { SqlClient } from "effect/sql"

export const ProcessRow = Schema.Struct({
  pid: Schema.Number,
  worktree: Schema.String,
  service: Schema.String
})
export type ProcessRow = typeof ProcessRow.Type

export type DesiredWorktree = {
  readonly slug: string
  readonly root: string
  readonly branch: string
  readonly stack_file: string
}

const isAlive = (pid: number) =>
  Effect.try({ try: () => process.kill(pid, 0), catch: () => false }).pipe(Effect.orElseSucceed(() => false))

const killGroup = (pid: number) =>
  Effect.try({ try: () => process.kill(-pid, "SIGKILL"), catch: () => false }).pipe(Effect.ignore)

export class Registry extends Context.Service<Registry, {
  readonly track: (row: ProcessRow) => Effect.Effect<void, never, Scope.Scope>
  readonly reaped: ReadonlyArray<ProcessRow>
  readonly desire: (worktree: DesiredWorktree, desired: "up" | "down") => Effect.Effect<void>
  readonly desiredUp: Effect.Effect<ReadonlyArray<DesiredWorktree>>
}>()("forkyard/Registry") {
  static readonly layer = Layer.effect(
    Registry,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ProcessRow))

      const track = (row: ProcessRow) =>
        Effect.acquireRelease(
          sql`INSERT OR REPLACE INTO processes ${sql.insert(row)}`.pipe(Effect.orDie),
          () => sql`DELETE FROM processes WHERE pid = ${row.pid}`.pipe(Effect.orDie)
        ).pipe(Effect.asVoid)

      const reapOrphans = Effect.fn("Registry.reapOrphans")(function*() {
        const rows = yield* sql`SELECT pid, worktree, service FROM processes`.pipe(Effect.flatMap(decodeRows))
        const alive = yield* Effect.filter(rows, (row) => isAlive(row.pid))
        yield* Effect.forEach(alive, (row) => killGroup(row.pid), { discard: true })
        yield* sql`DELETE FROM processes`
        yield* Effect.annotateCurrentSpan({ "forkyard.reaped": alive.length, "forkyard.reaped.services": alive.map((row) => `${row.worktree}/${row.service}`).join(", ") })
        yield* Effect.logInfo(`reaped ${alive.length} orphaned processes from a previous daemon`)
        return alive
      }, Effect.orDie)

      const reaped = yield* reapOrphans()

      const desire = (worktree: DesiredWorktree, desired: "up" | "down") =>
        sql`INSERT OR REPLACE INTO worktrees ${sql.insert({ ...worktree, desired })}`.pipe(Effect.orDie)

      const desiredUp = sql<DesiredWorktree>`
        SELECT slug, root, branch, stack_file FROM worktrees WHERE desired = 'up'
      `.pipe(Effect.orDie)

      return Registry.of({ track, reaped, desire, desiredUp })
    })
  )
}
