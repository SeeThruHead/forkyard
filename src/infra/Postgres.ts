import { PgClient } from "@effect/sql-pg"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { databaseName, InfraName, type Port } from "../Ids.ts"
import { type Env, InfraError, type InfraServer, type InfraSpec, type InfraTools, type Run, type Worktree } from "../Stack.ts"
import { containerName, dockerContainer, port, readyOrExit } from "./Shared.ts"

export type Database = {
  readonly url: string
  readonly database: string
  readonly host: string
  readonly port: Port
}

type Options = {
  readonly name?: string
  readonly image?: string
  readonly scope: "shared" | "worktree"
  readonly database?: (worktree: Worktree) => string
  readonly golden?: { readonly migrate: Run }
  readonly env?: (database: Database) => Env
}

const urlFor = (port: Port, database: string) => `postgres://postgres@127.0.0.1:${port}/${database}`

const onDatabase = <A, E>(port: Port, database: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(urlFor(port, database)) })))

const exists = Effect.fnUntraced(function* (database: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${database}`
  return (rows[0]?.n ?? 0) > 0
})

export const docker = (options: Options): InfraSpec => {
  const name = InfraName.make(options.name ?? "postgres")
  const image = options.image ?? "postgres:18"
  const fail = (message: string) => new InfraError({ infra: name, message })
  const step =
    (label: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((error) => fail(`${label}: ${String(error)}`)))
  const onServer = <A, E>(serverPort: Port, label: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    onDatabase(serverPort, "postgres", effect).pipe(step(label))

  const buildGolden = Effect.fn("Postgres.buildGolden")(
    function* (serverPort: Port, golden: string, migrate: Run, worktree: Worktree, tools: InfraTools) {
      yield* onServer(
        serverPort,
        "create golden",
        SqlClient.SqlClient.use((sql) => sql`CREATE DATABASE ${sql(golden)}`)
      )
      yield* tools
        .exec({ name: "golden migrate", run: migrate, env: { DATABASE_URL: urlFor(serverPort, golden) }, cwd: worktree.root })
        .pipe(Effect.scoped)
      yield* onServer(
        serverPort,
        "seal golden",
        SqlClient.SqlClient.use((sql) => sql`ALTER DATABASE ${sql(golden)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`)
      )
    },
    (effect, _port, golden, _migrate, worktree) =>
      effect.pipe(Effect.tap(() => Effect.logInfo(`[${name}] built golden template ${golden} from ${worktree.id}`)))
  )

  const ensureGolden = Effect.fn("Postgres.ensureGolden")(function* (
    serverPort: Port,
    golden: string,
    migrate: Run,
    worktree: Worktree,
    tools: InfraTools
  ) {
    yield* Effect.annotateCurrentSpan({ "db.namespace": golden, "forkyard.worktree": worktree.id })
    if (yield* onServer(serverPort, "check golden", exists(golden))) return

    yield* buildGolden(serverPort, golden, migrate, worktree, tools)
  })

  const createDatabase = Effect.fn("Postgres.createDatabase")(function* (serverPort: Port, database: string, template: string | undefined) {
    yield* Effect.annotateCurrentSpan({ "db.namespace": database, "forkyard.db.template": template ?? "" })
    yield* onServer(
      serverPort,
      "create database",
      SqlClient.SqlClient.use((sql) =>
        template
          ? sql`CREATE DATABASE ${sql(database)} TEMPLATE ${sql(template)} STRATEGY FILE_COPY`
          : sql`CREATE DATABASE ${sql(database)}`
      )
    )
  })

  const start = Effect.fn("Postgres.start")(function* (instance: string, tools: InfraTools) {
    const container = containerName(name, instance)
    const hostPort = yield* port(name)
    const clone = image.startsWith("postgres:18") ? ["-c", "file_copy_method=clone"] : []
    yield* Effect.annotateCurrentSpan({ "db.system.name": "postgresql", "container.image.name": image, "server.port": hostPort })
    const started = yield* dockerContainer(tools, {
      infra: name,
      name: container,
      args: [
        "-p",
        `127.0.0.1:${hostPort}:5432`,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "-v",
        `${container}-data:/var/lib/postgresql`,
        image,
        ...clone
      ]
    })
    yield* readyOrExit(
      name,
      started,
      onDatabase(
        hostPort,
        "postgres",
        SqlClient.SqlClient.use((sql) => sql`SELECT 1`)
      ),
      "60 seconds"
    )
    return { port: hostPort, env: {}, routes: {} }
  })

  const tenant = Effect.fn("Postgres.tenant")(function* (server: InfraServer, worktree: Worktree, tools: InfraTools) {
    if (!server.port) return yield* new InfraError({ infra: name, message: "server has no port" })
    const serverPort = server.port
    const database = options.database?.(worktree) ?? databaseName(worktree.project, worktree.branch)
    const template = options.golden ? databaseName(worktree.project, "golden") : undefined
    yield* Effect.annotateCurrentSpan({ "db.system.name": "postgresql", "db.namespace": database, "forkyard.worktree": worktree.id })
    if (options.golden && template) yield* server.exclusive(ensureGolden(serverPort, template, options.golden.migrate, worktree, tools))

    const present = yield* onServer(serverPort, "check database", exists(database))
    yield* Effect.annotateCurrentSpan({ "forkyard.db.created": !present })
    if (!present) yield* createDatabase(serverPort, database, template)

    const url = urlFor(serverPort, database)
    return options.env?.({ url, database, host: "127.0.0.1", port: serverPort }) ?? { DATABASE_URL: url }
  })

  return { name, scope: options.scope, start, tenant }
}
