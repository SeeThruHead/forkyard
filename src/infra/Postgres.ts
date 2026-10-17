import { PgClient } from "@effect/sql-pg"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { type Env, InfraError, type InfraServer, type InfraSpec, type InfraTools, type Run, type Worktree } from "../Stack.ts"
import { containerName, dockerContainer, port, readyOrExit, sanitize } from "./Shared.ts"

export type Database = {
  readonly url: string
  readonly database: string
  readonly host: string
  readonly port: number
}

type Options = {
  readonly name?: string
  readonly image?: string
  readonly scope: "shared" | "worktree"
  readonly database?: (worktree: Worktree) => string
  readonly golden?: { readonly migrate: Run }
  readonly env?: (database: Database) => Env
}

const urlFor = (port: number, database: string) => `postgres://postgres@127.0.0.1:${port}/${database}`

const onDatabase = <A, E>(port: number, database: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(urlFor(port, database)) })))

const exists = Effect.fnUntraced(function*(database: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${database}`
  return (rows[0]?.n ?? 0) > 0
})

export const docker = (options: Options): InfraSpec => {
  const name = options.name ?? "postgres"
  const image = options.image ?? "postgres:18"
  const fail = (message: string) => new InfraError({ infra: name, message })
  const step = (label: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((error) => fail(`${label}: ${String(error)}`)))
  const onServer = <A, E>(serverPort: number, label: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    onDatabase(serverPort, "postgres", effect).pipe(step(label))

  const ensureGolden = Effect.fn("Postgres.ensureGolden")(function*(serverPort: number, golden: string, migrate: Run, worktree: Worktree, tools: InfraTools) {
    yield* Effect.annotateCurrentSpan({ "db.namespace": golden, "forkyard.worktree": worktree.id })
    if (yield* onServer(serverPort, "check golden", exists(golden))) return

    yield* Effect.logInfo(`[${name}] building golden template ${golden} from ${worktree.id}`)
    yield* onServer(serverPort, "create golden", SqlClient.SqlClient.use((sql) => sql`CREATE DATABASE ${sql(golden)}`))
    yield* tools.exec({ name: "golden migrate", run: migrate, env: { DATABASE_URL: urlFor(serverPort, golden) }, cwd: worktree.root }).pipe(Effect.scoped)
    yield* onServer(serverPort, "seal golden", SqlClient.SqlClient.use((sql) => sql`ALTER DATABASE ${sql(golden)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`))
    yield* Effect.annotateCurrentSpan({ "forkyard.golden.built": true })
  })

  const createDatabase = Effect.fn("Postgres.createDatabase")(function*(serverPort: number, database: string, template: string | undefined) {
    yield* Effect.annotateCurrentSpan({ "db.namespace": database, "forkyard.db.template": template ?? "" })
    yield* onServer(
      serverPort,
      "create database",
      SqlClient.SqlClient.use((sql) =>
        template ? sql`CREATE DATABASE ${sql(database)} TEMPLATE ${sql(template)} STRATEGY FILE_COPY` : sql`CREATE DATABASE ${sql(database)}`
      )
    )
  })

  const start = Effect.fn("Postgres.start")(function*(instance: string, tools: InfraTools) {
    const container = containerName(name, instance)
    const hostPort = yield* port(name)
    const clone = image.startsWith("postgres:18") ? ["-c", "file_copy_method=clone"] : []
    yield* Effect.annotateCurrentSpan({ "db.system.name": "postgresql", "container.image.name": image, "server.port": hostPort })
    const started = yield* dockerContainer(tools, {
      infra: name,
      name: container,
      args: ["-p", `127.0.0.1:${hostPort}:5432`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-v", `${container}-data:/var/lib/postgresql`, image, ...clone]
    })
    yield* readyOrExit(name, started, onDatabase(hostPort, "postgres", SqlClient.SqlClient.use((sql) => sql`SELECT 1`)), "60 seconds")
    return { port: hostPort, env: {}, routes: {} }
  })

  const tenant = Effect.fn("Postgres.tenant")(function*(server: InfraServer, worktree: Worktree, tools: InfraTools) {
    const database = options.database?.(worktree) ?? sanitize(`${worktree.project}_${worktree.branch}`)
    const template = options.golden ? sanitize(`${worktree.project}_golden`) : undefined
    yield* Effect.annotateCurrentSpan({ "db.system.name": "postgresql", "db.namespace": database, "forkyard.worktree": worktree.id })
    if (options.golden && template) yield* server.exclusive(ensureGolden(server.port, template, options.golden.migrate, worktree, tools))

    const present = yield* onServer(server.port, "check database", exists(database))
    yield* Effect.annotateCurrentSpan({ "forkyard.db.created": !present })
    if (!present) yield* createDatabase(server.port, database, template)

    const url = urlFor(server.port, database)
    return options.env?.({ url, database, host: "127.0.0.1", port: server.port }) ?? { DATABASE_URL: url }
  })

  return { name, scope: options.scope, start, tenant }
}
