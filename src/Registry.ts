import { Clock, Context, Effect, FileSystem, Layer, Schema, type Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { Os } from "./platform/Os.ts"
import { uptime } from "node:os"
import { AbsolutePath, BranchSlug, Pid, ProcessOwner, type ProjectName, type WorktreeId, worktreeId } from "./Ids.ts"

export const ProcessRow = Schema.Struct({
  pid: Pid,
  daemon_id: Schema.String,
  boot_minute: Schema.Int,
  started_at: Schema.NullOr(Schema.Finite)
})
export type ProcessRow = typeof ProcessRow.Type

export const DesiredWorktree = Schema.Struct({
  slug: Schema.String,
  root: AbsolutePath,
  branch: Schema.String,
  profile: Schema.String,
  stack_file: AbsolutePath
})
export type DesiredWorktree = typeof DesiredWorktree.Type

const NamedFolder = Schema.Struct({ slug: Schema.String, root: Schema.String })

const isNameFrom = (name: string, base: string) => name === base || new RegExp(`^${base}-\\d+$`).test(name)

export const firstFreeName = (base: BranchSlug, project: ProjectName, taken: ReadonlySet<string>, attempt = 1): BranchSlug => {
  const name = BranchSlug.make(attempt === 1 ? base : `${base}-${attempt}`)
  if (!taken.has(worktreeId(name, project))) return name
  return firstFreeName(base, project, taken, attempt + 1)
}

type Identity = { readonly daemonId: string; readonly bootMinute: number }

const bootMinute = Clock.currentTimeMillis.pipe(Effect.map((now) => Math.round((now - uptime() * 1000) / 60_000)))

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
    readonly nameFor: (root: AbsolutePath, project: ProjectName, base: BranchSlug) => Effect.Effect<BranchSlug>
    readonly markUp: (worktree: DesiredWorktree) => Effect.Effect<void>
    readonly markDown: (id: WorktreeId) => Effect.Effect<void>
    readonly desiredUp: Effect.Effect<ReadonlyArray<DesiredWorktree>>
  }
>()("forkyard/Registry") {
  static readonly layer = Layer.effect(
    Registry,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const fs = yield* FileSystem.FileSystem
      const os = yield* Os
      const random = yield* SecureRandom.SecureRandom
      const identity: Identity = { daemonId: yield* random.uuidV4(), bootMinute: yield* bootMinute }

      const previousProcesses = sql`SELECT pid, daemon_id, boot_minute, started_at FROM processes`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProcessRow))),
        Effect.orDie
      )

      const stillTheSameProcess = (row: ProcessRow) =>
        row.started_at === null ? Effect.succeed(false) : os.startedAt(row.pid).pipe(Effect.map((now) => now === row.started_at))

      const reapOrphans = Effect.fn("Registry.reapOrphans")(
        function* () {
          const rows = yield* previousProcesses
          const candidates = rows.filter(fromThisBoot(identity)).filter(fromAnotherDaemon(identity))
          const alive = yield* Effect.filter(candidates, stillTheSameProcess)

          yield* Effect.forEach(alive, (row) => os.killTree(row.pid), { discard: true })
          yield* sql`DELETE FROM processes`.pipe(Effect.orDie)

          yield* Effect.annotateCurrentSpan({ "forkyard.reaped": alive.length, "forkyard.stale_rows": rows.length - candidates.length })
          return alive
        },
        Effect.tap((alive) => Effect.logInfo(`reaped ${alive.length} orphaned processes from a previous daemon`))
      )

      const track = Effect.fnUntraced(function* (process: { readonly pid: Pid; readonly owner: ProcessOwner; readonly service: string }) {
        const row = {
          pid: process.pid,
          worktree: process.owner,
          service: process.service,
          daemon_id: identity.daemonId,
          boot_minute: identity.bootMinute,
          started_at: (yield* os.startedAt(process.pid)) ?? null
        }
        const insert = sql`INSERT OR REPLACE INTO processes ${sql.insert(row)}`.pipe(Effect.orDie)
        const remove = sql`DELETE FROM processes WHERE pid = ${process.pid} AND daemon_id = ${identity.daemonId}`.pipe(Effect.orDie)

        yield* Effect.acquireRelease(insert, () => remove)
      })

      const folders = sql`SELECT slug, root FROM worktrees`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(NamedFolder))),
        Effect.orDie
      )

      const stillExists = (root: string) => fs.exists(root).pipe(Effect.orElseSucceed(() => false))

      const nameFor = Effect.fn("Registry.nameFor")(function* (root: AbsolutePath, project: ProjectName, base: BranchSlug) {
        const rows = yield* folders
        const mine = rows.find((row) => row.root === root)?.slug
        const others = yield* Effect.filter(
          rows.filter((row) => row.root !== root),
          (row) => stillExists(row.root)
        )
        const taken = new Set(others.map((row) => row.slug))
        const kept = mine?.slice(0, -(project.length + 1))
        if (mine && kept && isNameFrom(kept, base) && !taken.has(mine)) return BranchSlug.make(kept)
        return firstFreeName(base, project, taken)
      })

      const markUp = (worktree: DesiredWorktree) =>
        sql`DELETE FROM worktrees WHERE slug = ${worktree.slug} AND root <> ${worktree.root}`.pipe(
          Effect.andThen(sql`INSERT OR REPLACE INTO worktrees ${sql.insert({ ...worktree, desired: "up" })}`),
          Effect.asVoid,
          Effect.orDie
        )

      const markDown = (id: WorktreeId) => sql`UPDATE worktrees SET desired = 'down' WHERE slug = ${id}`.pipe(Effect.asVoid, Effect.orDie)

      const desiredUp = sql`SELECT slug, root, branch, profile, stack_file FROM worktrees WHERE desired = 'up'`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DesiredWorktree))),
        Effect.orDie
      )

      yield* reapOrphans()

      return Registry.of({ track, nameFor, markUp, markDown, desiredUp })
    })
  )
}
