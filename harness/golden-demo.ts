import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Clock, Console, Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { Golden } from "../src/Golden.ts"

const url = (database: string) => Redacted.make(`postgres://postgres:x@127.0.0.1:55432/${database}`)

const onDatabase = <A, E>(database: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(PgClient.layer({ url: url(database) })))

const timed = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const start = yield* Clock.currentTimeMillis
    const result = yield* effect
    yield* Console.log(`    ${label}: ${(yield* Clock.currentTimeMillis) - start} ms`)
    return result
  })

const columns = (database: string) =>
  onDatabase(
    database,
    SqlClient.SqlClient.pipe(
      Effect.flatMap((sql) => sql<{ readonly column_name: string }>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'customers' ORDER BY ordinal_position
      `),
      Effect.map((rows) => rows.map((row) => row.column_name).join(", "))
    )
  )

const program = Effect.gen(function*() {
  const golden = yield* Golden
  const sql = yield* SqlClient.SqlClient

  yield* Console.log("== seed shop_golden (stands in for a dump load) and mark it a template")
  yield* sql`DROP DATABASE IF EXISTS shop_golden`
  yield* sql`CREATE DATABASE shop_golden`
  yield* onDatabase(
    "shop_golden",
    SqlClient.SqlClient.pipe(Effect.flatMap((db) =>
      Effect.all([
        db`CREATE TABLE customers (id int PRIMARY KEY, email text)`,
        db`INSERT INTO customers SELECT g, 'user' || g || '@example.com' FROM generate_series(1, 200000) g`
      ])
    ))
  )
  yield* sql.unsafe(`COMMENT ON DATABASE shop_golden IS 'commit-1'`)
  yield* sql`ALTER DATABASE shop_golden WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`
  yield* Console.log(`    golden at ${yield* golden.commit}, columns: ${yield* columns("shop_golden").pipe(Effect.orElseSucceed(() => "(no connections allowed)"))}`)

  yield* Console.log("== two worktrees provision at once (read lock, run concurrently)")
  yield* timed(
    "wt-a + wt-b cloned",
    Effect.all([golden.provision("wt-a"), golden.provision("wt-b")], { concurrency: "unbounded" })
  )
  yield* onDatabase("shop_wt_wt_a", SqlClient.SqlClient.pipe(Effect.flatMap((db) => db`DELETE FROM customers WHERE id > 10`)))
  const count = (database: string) =>
    onDatabase(database, SqlClient.SqlClient.pipe(Effect.flatMap((db) => db<{ readonly n: number }>`SELECT count(*)::int AS n FROM customers`), Effect.map((rows) => rows[0]?.n)))
  yield* Console.log(`    after deleting rows in wt-a: wt-a has ${yield* count("shop_wt_wt_a")}, wt-b has ${yield* count("shop_wt_wt_b")}`)

  yield* Console.log("== main gains a migration: refresh golden in the background")
  const migrate = (database: string) =>
    onDatabase(database, SqlClient.SqlClient.pipe(Effect.flatMap((db) => db`ALTER TABLE customers ADD COLUMN tier text`)))
  yield* Console.log(`    ${yield* timed("refresh to commit-2", golden.refresh({ commit: "commit-2", migrate }))}`)
  yield* Console.log(`    again: ${yield* golden.refresh({ commit: "commit-2", migrate })}`)
  yield* golden.provision("wt-c")
  yield* Console.log(`    new worktree wt-c columns: ${yield* columns("shop_wt_wt_c")}`)
  yield* Console.log(`    existing wt-a columns:     ${yield* columns("shop_wt_wt_a")}  (its own migrate watcher catches up)`)

  yield* Console.log("== a broken migration on main leaves golden untouched")
  const broken = (database: string) =>
    onDatabase(database, SqlClient.SqlClient.pipe(Effect.flatMap((db) => db`ALTER TABLE nope ADD COLUMN x int`)))
  const failure = yield* golden.refresh({ commit: "commit-3", migrate: broken }).pipe(Effect.flip)
  yield* Console.log(`    refresh failed (${failure._tag}), golden still at ${yield* golden.commit}`)
  const leftovers = yield* sql<{ readonly datname: string }>`SELECT datname FROM pg_database WHERE datname LIKE 'shop_golden%' ORDER BY 1`
  yield* Console.log(`    golden databases: ${leftovers.map((row) => row.datname).join(", ")}`)

  yield* Console.log("== snapshot and release are SQL too")
  yield* Console.log(`    ${yield* timed("snapshot wt-b", golden.snapshot("wt-b", "before-test"))}`)
  yield* timed("release wt-a, wt-b, wt-c", Effect.forEach(["wt-a", "wt-b", "wt-c"], golden.release, { discard: true }))
})

program.pipe(
  Effect.provide(Golden.layer({ golden: "shop_golden", prefix: "shop_wt" }).pipe(Layer.provideMerge(PgClient.layer({ url: url("postgres") })))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
