import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Exit, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { Golden } from "../src/Golden.ts"

const testPort = process.env.FORKYARD_TEST_POSTGRES_PORT

const onDatabase = (database: string) => PgClient.layer({ url: Redacted.make(`postgres://postgres@127.0.0.1:${testPort}/${database}`) })

const namesLike = (prefix: string) =>
  SqlClient.SqlClient.use(
    (sql) => sql<{ readonly datname: string }>`SELECT datname FROM pg_database WHERE datname LIKE ${`${prefix}%`} ORDER BY datname`
  ).pipe(
    Effect.map((rows) => rows.map((row) => row.datname)),
    Effect.provide(onDatabase("postgres"))
  )

const holdASession = (database: string) =>
  SqlClient.SqlClient.use((sql) => sql`SELECT pg_sleep(20)`).pipe(
    Effect.provide(onDatabase(database)),
    Effect.ignore,
    Effect.forkScoped,
    Effect.andThen(Effect.sleep("300 millis"))
  )

describe.skipIf(!testPort)("golden swap against a real server (FORKYARD_TEST_POSTGRES_PORT)", () => {
  it.live(
    "leaves the old golden in place when the swap cannot finish",
    () =>
      Effect.gen(function* () {
        const golden = `swap${(yield* Clock.currentTimeMillis).toString(36)}_golden`
        yield* SqlClient.SqlClient.use((sql) => sql`CREATE DATABASE ${sql(golden)}`).pipe(Effect.provide(onDatabase("postgres")))
        const refreshed = yield* Golden.use((service) => service.refresh({ commit: "abc", migrate: holdASession })).pipe(
          Effect.provide(Golden.layer({ golden, prefix: "swap_wt" }).pipe(Layer.provide(onDatabase("postgres")))),
          Effect.exit
        )

        expect(Exit.isFailure(refreshed)).toBe(true)
        expect(yield* namesLike(golden)).toEqual([golden, `${golden}_next`])
      }).pipe(Effect.scoped),
    60_000
  )
})
