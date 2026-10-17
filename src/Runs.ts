import { Clock, Context, Effect, Layer, type Scope } from "effect"
import type { RunInfo, RunLine } from "./Model.ts"
import { SqlClient } from "effect/sql"

type RunRow = {
  readonly id: number
  readonly worktree: string
  readonly service: string
  readonly n: number
  readonly pid: number
  readonly command: string
  readonly started_at: number
  readonly ended_at: number | null
  readonly exit_code: number | null
}

const toInfo = (row: RunRow): RunInfo => ({
  id: row.id,
  worktree: row.worktree,
  service: row.service,
  n: row.n,
  pid: row.pid,
  command: row.command,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  exitCode: row.exit_code
})

export class Runs extends Context.Service<Runs, {
  readonly begin: (run: {
    readonly worktree: string
    readonly service: string
    readonly pid: number
    readonly command: string
  }) => Effect.Effect<RunInfo, never, Scope.Scope>
  readonly exited: (runId: number, exitCode: number) => Effect.Effect<void>
  readonly append: (lines: ReadonlyArray<RunLine>) => Effect.Effect<void>
  readonly list: (worktree: string, service: string) => Effect.Effect<ReadonlyArray<RunInfo>>
  readonly lines: (runId: number) => Effect.Effect<ReadonlyArray<RunLine>>
  readonly ended: (runId: number) => Effect.Effect<boolean>
  readonly closeDangling: Effect.Effect<void>
}>()("forkyard/Runs") {
  static readonly layer = Layer.effect(
    Runs,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const insert = Effect.fnUntraced(function*(run: { readonly worktree: string; readonly service: string; readonly pid: number; readonly command: string }) {
          const now = yield* Clock.currentTimeMillis
          const rows = yield* sql<RunRow>`
            INSERT INTO runs (worktree, service, n, pid, command, started_at)
            VALUES (
              ${run.worktree}, ${run.service},
              (SELECT coalesce(max(n), 0) + 1 FROM runs WHERE worktree = ${run.worktree} AND service = ${run.service}),
              ${run.pid}, ${run.command}, ${now}
            )
            RETURNING *
          `
          return toInfo(rows[0]!)
        }, Effect.orDie)

      const end = (runId: number) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => sql`UPDATE runs SET ended_at = ${now} WHERE id = ${runId} AND ended_at IS NULL`),
          Effect.orDie
        )

      const begin = (run: { readonly worktree: string; readonly service: string; readonly pid: number; readonly command: string }) =>
        Effect.acquireRelease(insert(run), (info) => end(info.id))

      const exited = (runId: number, exitCode: number) =>
        sql`UPDATE runs SET exit_code = ${exitCode} WHERE id = ${runId}`.pipe(Effect.asVoid, Effect.orDie)

      const append = (lines: ReadonlyArray<RunLine>) =>
        lines.length === 0
          ? Effect.void
          : sql`INSERT OR IGNORE INTO log_lines ${sql.insert(lines.map((line) => ({ run_id: line.runId, seq: line.seq, at: line.at, line: line.line })))}`.pipe(
            Effect.asVoid,
            Effect.orDie
          )

      const list = (worktree: string, service: string) =>
        sql<RunRow>`SELECT * FROM runs WHERE worktree = ${worktree} AND service = ${service} ORDER BY n DESC LIMIT 50`.pipe(
          Effect.map((rows) => rows.map(toInfo)),
          Effect.orDie
        )

      const lines = (runId: number) =>
        sql<{ readonly run_id: number; readonly seq: number; readonly at: number; readonly line: string }>`
          SELECT run_id, seq, at, line FROM log_lines WHERE run_id = ${runId} ORDER BY seq
        `.pipe(
          Effect.map((rows) => rows.map((row) => ({ runId: row.run_id, seq: row.seq, at: row.at, line: row.line }))),
          Effect.orDie
        )

      const ended = (runId: number) =>
        sql<{ readonly ended_at: number | null }>`SELECT ended_at FROM runs WHERE id = ${runId}`.pipe(
          Effect.map((rows) => rows[0]?.ended_at !== null),
          Effect.orDie
        )

      const closeDangling = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => sql`UPDATE runs SET ended_at = ${now} WHERE ended_at IS NULL`),
        Effect.asVoid,
        Effect.orDie
      )

      yield* closeDangling

      return Runs.of({ begin, exited, append, list, lines, ended, closeDangling })
    })
  )
}
