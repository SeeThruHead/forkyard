import { Clock, Context, Crypto, Effect, Layer, Schema, type Scope } from "effect"
import { SqlClient } from "effect/sql"
import { uptime } from "node:os"
import { AbsolutePath, Pid, ProcessOwner, type WorktreeId } from "./Ids.ts"

export const ProcessRow = Schema.Struct({
  pid: Pid,
  worktree: ProcessOwner,
  service: Schema.String,
  daemon_id: Schema.String,
  boot_minute: Schema.Int
})
export type ProcessRow = typeof ProcessRow.Type

export const DesiredWorktree = Schema.Struct({
  slug: Schema.String,
  root: AbsolutePath,
  branch: Schema.String,
  stack_file: AbsolutePath
})
export type DesiredWorktree = typeof DesiredWorktree.Type

type Identity = { readonly daemonId: string; readonly bootMinute: number }

const bootMinute = Clock.currentTimeMillis.pipe(Effect.map((now) => Math.round((now - uptime() * 1000) / 60_000)))

const isAlive = (pid: Pid) => Effect.try({ try: () => process.kill(pid, 0), catch: () => false }).pipe(Effect.orElseSucceed(() => false))

const killGroup = (pid: Pid) => Effect.try({ try: () => process.kill(-pid, "SIGKILL"), catch: () => false }).pipe(Effect.ignore)

const fromThisBoot = (identity: Identity) => (row: ProcessRow) => Math.abs(row.boot_minute - identity.bootMinute) <= 1

const fromAnotherDaemon = (identity: Identity) => (row: ProcessRow) => row.daemon_id !== identity.daemonId

export class Registry extends Context.Service<
  Registry,
  {
    readonly track: (process: {
      readonly pid: Pid
      readonly owner: ProcessOwner
      readonly service: string
    }) => Effect.Effect<void, never, Scope.Scope>
    readonly reaped: ReadonlyArray<ProcessRow>
    readonly markUp: (worktree: DesiredWorktree) => Effect.Effect<void>
    readonly markDown: (id: WorktreeId) => Effect.Effect<void>
    readonly desiredUp: Effect.Effect<ReadonlyArray<DesiredWorktree>>
  }
>()("forkyard/Registry") {
  static readonly layer = Layer.effect(
    Registry,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const crypto = yield* Crypto.Crypto
      const identity: Identity = { daemonId: yield* crypto.randomUUIDv4().pipe(Effect.orDie), bootMinute: yield* bootMinute }

      const previousProcesses = sql`SELECT pid, worktree, service, daemon_id, boot_minute FROM processes`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProcessRow))),
        Effect.orDie
      )

      const reapOrphans = Effect.fn("Registry.reapOrphans")(
        function* () {
          const rows = yield* previousProcesses
          const candidates = rows.filter(fromThisBoot(identity)).filter(fromAnotherDaemon(identity))
          const alive = yield* Effect.filter(candidates, (row) => isAlive(row.pid))

          yield* Effect.forEach(alive, (row) => killGroup(row.pid), { discard: true })
          yield* sql`DELETE FROM processes`.pipe(Effect.orDie)

          yield* Effect.annotateCurrentSpan({ "forkyard.reaped": alive.length, "forkyard.stale_rows": rows.length - candidates.length })
          return alive
        },
        Effect.tap((alive) => Effect.logInfo(`reaped ${alive.length} orphaned processes from a previous daemon`))
      )

      const track = (process: { readonly pid: Pid; readonly owner: ProcessOwner; readonly service: string }) => {
        const row = {
          pid: process.pid,
          worktree: process.owner,
          service: process.service,
          daemon_id: identity.daemonId,
          boot_minute: identity.bootMinute
        }
        const insert = sql`INSERT OR REPLACE INTO processes ${sql.insert(row)}`.pipe(Effect.orDie)
        const remove = sql`DELETE FROM processes WHERE pid = ${process.pid} AND daemon_id = ${identity.daemonId}`.pipe(Effect.orDie)

        return Effect.acquireRelease(insert, () => remove).pipe(Effect.asVoid)
      }

      const markUp = (worktree: DesiredWorktree) =>
        sql`INSERT OR REPLACE INTO worktrees ${sql.insert({ ...worktree, desired: "up" })}`.pipe(Effect.asVoid, Effect.orDie)

      const markDown = (id: WorktreeId) => sql`UPDATE worktrees SET desired = 'down' WHERE slug = ${id}`.pipe(Effect.asVoid, Effect.orDie)

      const desiredUp = sql`SELECT slug, root, branch, stack_file FROM worktrees WHERE desired = 'up'`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DesiredWorktree))),
        Effect.orDie
      )

      const reaped = yield* reapOrphans()

      return Registry.of({ track, reaped, markUp, markDown, desiredUp })
    })
  )
}
