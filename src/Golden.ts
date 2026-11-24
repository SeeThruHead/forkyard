import { Context, Effect, Layer, Schema, Semaphore, TxReentrantLock } from "effect"
import { SqlClient } from "effect/sql"

export class GoldenError extends Schema.TaggedError<GoldenError>()("GoldenError", {
  step: Schema.String,
  cause: Schema.Defect()
}) {}

export class Golden extends Context.Service<
  Golden,
  {
    readonly provision: (slug: string) => Effect.Effect<string, GoldenError>
    readonly release: (slug: string) => Effect.Effect<void, GoldenError>
    readonly snapshot: (slug: string, name: string) => Effect.Effect<string, GoldenError>
    readonly refresh: <E, R>(options: {
      readonly commit: string
      readonly migrate: (database: string) => Effect.Effect<void, E, R>
    }) => Effect.Effect<"refreshed" | "up-to-date", GoldenError | E, R>
    readonly commit: Effect.Effect<string | undefined, GoldenError>
  }
>()("forkyard/Golden") {
  static readonly layer = (options: { readonly golden: string; readonly prefix: string }) =>
    Layer.effect(
      Golden,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const lock = yield* TxReentrantLock.make()
        const refreshing = yield* Semaphore.make(1)
        const golden = options.golden
        const databaseFor = (slug: string) => `${options.prefix}_${slug.replaceAll("-", "_")}`
        const next = `${golden}_next`
        const old = `${golden}_old`

        const step =
          (name: string) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.mapError((cause) => new GoldenError({ step: name, cause })),
              Effect.withSpan(`Golden.${name}`)
            )

        const exists = (database: string) =>
          sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${database}`.pipe(
            Effect.map((rows) => (rows[0]?.n ?? 0) > 0)
          )

        const cloneFrom = (template: string, target: string) =>
          sql`CREATE DATABASE ${sql(target)} TEMPLATE ${sql(template)} STRATEGY FILE_COPY`

        const commit = sql<{ readonly comment: string | null }>`
          SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = ${golden}
        `.pipe(
          Effect.map((rows) => rows[0]?.comment ?? undefined),
          step("commit")
        )

        const dropNext = sql`DROP DATABASE IF EXISTS ${sql(next)} WITH (FORCE)`.pipe(Effect.asVoid)

        const provision = Effect.fn("Golden.provision")(
          function* (slug: string) {
            const database = databaseFor(slug)
            if (yield* exists(database)) return database

            yield* cloneFrom(golden, database)
            return database
          },
          step("provision"),
          (effect) => TxReentrantLock.withReadLock(lock, effect)
        )

        const release = (slug: string) =>
          sql`DROP DATABASE IF EXISTS ${sql(databaseFor(slug))} WITH (FORCE)`.pipe(Effect.asVoid, step("release"))

        const snapshot = Effect.fn("Golden.snapshot")(function* (slug: string, name: string) {
          const target = `${databaseFor(slug)}__${name}`

          yield* cloneFrom(databaseFor(slug), target)
          return target
        }, step("snapshot"))

        const swap = Effect.fn("Golden.swap")(
          function* () {
            yield* sql.withTransaction(
              Effect.all(
                [
                  sql`ALTER DATABASE ${sql(next)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`,
                  sql`ALTER DATABASE ${sql(golden)} WITH IS_TEMPLATE false`,
                  sql`ALTER DATABASE ${sql(golden)} RENAME TO ${sql(old)}`,
                  sql`ALTER DATABASE ${sql(next)} RENAME TO ${sql(golden)}`
                ],
                { discard: true }
              )
            )
            yield* sql`DROP DATABASE ${sql(old)}`
          },
          step("swap"),
          (effect) => TxReentrantLock.withWriteLock(lock, effect)
        )

        const prepareNext = Effect.fn("Golden.prepareNext")(function* () {
          yield* dropNext.pipe(step("clean"))
          yield* cloneFrom(golden, next).pipe(step("clone"))
          yield* sql`ALTER DATABASE ${sql(next)} WITH ALLOW_CONNECTIONS true`.pipe(step("open"))
        })

        const migrateNext = <E, R>(migrate: (database: string) => Effect.Effect<void, E, R>) =>
          migrate(next).pipe(Effect.tapError(() => dropNext.pipe(Effect.ignore)))

        const stamp = (commitId: string) =>
          sql.unsafe(`COMMENT ON DATABASE "${next}" IS '${commitId.replaceAll("'", "")}'`).pipe(step("stamp"))

        const refresh = Effect.fn("Golden.refresh")(function* <E, R>(options: {
          readonly commit: string
          readonly migrate: (database: string) => Effect.Effect<void, E, R>
        }) {
          yield* Effect.annotateCurrentSpan({ "vcs.ref.head.revision": options.commit })
          if ((yield* commit) === options.commit) return "up-to-date" as const

          yield* prepareNext()
          yield* migrateNext(options.migrate)
          yield* stamp(options.commit)
          yield* swap()

          return "refreshed" as const
        }, Semaphore.withPermit(refreshing))

        return Golden.of({ provision, release, snapshot, refresh, commit })
      })
    )
}
