import { Array, Clock, Context, Effect, Layer, Schema, type Scope } from "effect"
import { SqlClient } from "effect/sql"
import { Pid, ProcessOwner, RunId, RunNumber } from "./Ids.ts"
import type { RunInfo, RunLine } from "./Model.ts"

const RunRow = Schema.Struct({
  id: RunId,
  worktree: ProcessOwner,
  service: Schema.String,
  n: RunNumber,
  pid: Pid,
  command: Schema.String,
  started_at: Schema.Number,
  ended_at: Schema.NullOr(Schema.Number),
  exit_code: Schema.NullOr(Schema.Int)
})
type RunRow = typeof RunRow.Type

const LineRow = Schema.Struct({ run_id: RunId, seq: Schema.Int, at: Schema.Number, line: Schema.String })

const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunRow))
const decodeLines = Schema.decodeUnknownEffect(Schema.Array(LineRow))

const toInfo = (row: RunRow): RunInfo => {
  const base = {
    id: row.id,
    owner: row.worktree,
    service: row.service,
    n: row.n,
    pid: row.pid,
    command: row.command,
    startedAt: row.started_at
  }

  if (row.ended_at === null) return { _tag: "Running", ...base }
  if (row.exit_code === null) return { _tag: "Stopped", ...base, endedAt: row.ended_at }
  return { _tag: "Exited", ...base, endedAt: row.ended_at, exitCode: row.exit_code }
}

type NewRun = {
  readonly owner: ProcessOwner
  readonly service: string
  readonly pid: Pid
  readonly command: string
}

export class Runs extends Context.Service<
  Runs,
  {
    readonly begin: (run: NewRun) => Effect.Effect<RunInfo, never, Scope.Scope>
    readonly exited: (runId: RunId, exitCode: number) => Effect.Effect<void>
    readonly append: (lines: ReadonlyArray<RunLine>) => Effect.Effect<void>
    readonly list: (owner: ProcessOwner, service: string) => Effect.Effect<ReadonlyArray<RunInfo>>
    readonly lines: (runId: RunId) => Effect.Effect<ReadonlyArray<RunLine>>
    readonly ended: (runId: RunId) => Effect.Effect<boolean>
  }
>()("forkyard/Runs") {
  static readonly layer = Layer.effect(
    Runs,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const insert = Effect.fnUntraced(function* (run: NewRun) {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql`
          INSERT INTO runs (worktree, service, n, pid, command, started_at)
          VALUES (
            ${run.owner}, ${run.service},
            (SELECT coalesce(max(n), 0) + 1 FROM runs WHERE worktree = ${run.owner} AND service = ${run.service}),
            ${run.pid}, ${run.command}, ${now}
          )
          RETURNING *
        `.pipe(Effect.flatMap(decodeRuns))

        return toInfo(rows[0]!)
      }, Effect.orDie)

      const end = (runId: RunId) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => sql`UPDATE runs SET ended_at = ${now} WHERE id = ${runId} AND ended_at IS NULL`),
          Effect.asVoid,
          Effect.orDie
        )

      const begin = (run: NewRun) => Effect.acquireRelease(insert(run), (info) => end(info.id))

      const exited = (runId: RunId, exitCode: number) =>
        sql`UPDATE runs SET exit_code = ${exitCode} WHERE id = ${runId}`.pipe(Effect.asVoid, Effect.orDie)

      const toRow = (line: RunLine) => ({ run_id: line.runId, seq: line.seq, at: line.at, line: line.line })

      const append = (lines: ReadonlyArray<RunLine>) =>
        Array.isReadonlyArrayNonEmpty(lines)
          ? sql`INSERT OR IGNORE INTO log_lines ${sql.insert(Array.map(lines, toRow))}`.pipe(Effect.asVoid, Effect.orDie)
          : Effect.void

      const list = (owner: ProcessOwner, service: string) =>
        sql`SELECT * FROM runs WHERE worktree = ${owner} AND service = ${service} ORDER BY n DESC LIMIT 50`.pipe(
          Effect.flatMap(decodeRuns),
          Effect.map((rows) => rows.map(toInfo)),
          Effect.orDie
        )

      const lines = (runId: RunId) =>
        sql`SELECT run_id, seq, at, line FROM log_lines WHERE run_id = ${runId} ORDER BY seq`.pipe(
          Effect.flatMap(decodeLines),
          Effect.map((rows) => rows.map((row) => ({ runId: row.run_id, seq: row.seq, at: row.at, line: row.line }))),
          Effect.orDie
        )

      const ended = (runId: RunId) =>
        sql`SELECT ended_at FROM runs WHERE id = ${runId}`.pipe(
          Effect.map((rows) => rows[0]?.["ended_at"] !== null),
          Effect.orDie
        )

      const closeDangling = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => sql`UPDATE runs SET ended_at = ${now} WHERE ended_at IS NULL`),
        Effect.orDie
      )

      yield* closeDangling

      return Runs.of({ begin, exited, append, list, lines, ended })
    })
  )
}
