import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { Migrator, SqlClient } from "effect/sql"

const migrations = Migrator.fromRecord({
  "1_processes": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE processes (pid INTEGER PRIMARY KEY, worktree TEXT NOT NULL, service TEXT NOT NULL)`
  }),
  "2_worktrees": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE worktrees (slug TEXT PRIMARY KEY, root TEXT NOT NULL, desired TEXT NOT NULL)`
  }),
  "3_runs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worktree TEXT NOT NULL,
      service TEXT NOT NULL,
      n INTEGER NOT NULL,
      pid INTEGER NOT NULL,
      command TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER
    )`
    yield* sql`CREATE INDEX runs_by_service ON runs (worktree, service, n)`
    yield* sql`CREATE TABLE log_lines (
      run_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      at INTEGER NOT NULL,
      line TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    )`
  }),
  "4_worktree_branch": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE worktrees ADD COLUMN branch TEXT NOT NULL DEFAULT ''`
    yield* sql`ALTER TABLE worktrees ADD COLUMN stack_file TEXT NOT NULL DEFAULT ''`
  }),
  "5_process_identity": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE processes ADD COLUMN daemon_id TEXT NOT NULL DEFAULT ''`
    yield* sql`ALTER TABLE processes ADD COLUMN boot_minute INTEGER NOT NULL DEFAULT 0`
  })
})

export const layer = (filename: string) =>
  SqliteMigrator.layer({ loader: migrations }).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
