import { PgClient } from "@effect/sql-pg"
import { type Duration, Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { databaseName, InfraName, type Port } from "../Ids.ts"
import { cmd, type Env, InfraError, type InfraServer, type InfraSpec, type InfraTools, type Run, toRun, type Worktree } from "../Stack.ts"
import { containerName, dockerContainer, dockerReach, port, publish, readyOrExit } from "./Shared.ts"

export type Database = {
  readonly url: string
  readonly database: string
  readonly host: string
  readonly port: Port
}

export type Golden = { readonly migrate: string | Run } | { readonly snapshot: { readonly worktree: string } }

export type Copy = "clone" | "full"

type Options = {
  readonly name?: string
  readonly image?: string
  readonly scope: "shared" | "worktree"
  readonly database?: (worktree: Worktree) => string
  readonly golden?: Golden
  readonly copy?: Copy
  readonly env?: (database: Database) => Env
  readonly reapAfter?: Duration.Input | false
}

const cloningFilesystems = ["btrfs", "xfs", "zfs", "apfs"]

const urlFor = (port: Port, database: string) => dockerReach.pipe(Effect.map((reach) => `postgres://postgres@${reach}:${port}/${database}`))

const majorVersion = (image: string) => Number(/postgres:(\d+)/.exec(image)?.[1] ?? "0")

const dataPath = (image: string) => {
  const major = majorVersion(image)
  if (major > 0 && major < 18) return "/var/lib/postgresql/data"
  return "/var/lib/postgresql"
}

const variantOf = (image: string) => image.toLowerCase().replace(/[^a-z0-9]+/g, "-")

const onDatabase = <A, E>(port: Port, database: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  urlFor(port, database).pipe(Effect.flatMap((url) => effect.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) })))))

const exists = Effect.fnUntraced(function* (database: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${database}`
  return (rows[0]?.n ?? 0) > 0
})

const sealed = Effect.fnUntraced(function* (database: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${database} AND datistemplate`
  return (rows[0]?.n ?? 0) > 0
})

const closeTo = (database: string) =>
  SqlClient.SqlClient.use((sql) =>
    sql`ALTER DATABASE ${sql(database)} WITH ALLOW_CONNECTIONS false`.pipe(
      Effect.andThen(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${database} AND pid <> pg_backend_pid()`)
    )
  )

const openTo = (database: string) => SqlClient.SqlClient.use((sql) => sql`ALTER DATABASE ${sql(database)} WITH ALLOW_CONNECTIONS true`)

const createFrom = (database: string, template: string) =>
  SqlClient.SqlClient.use((sql) => sql`CREATE DATABASE ${sql(database)} TEMPLATE ${sql(template)} STRATEGY FILE_COPY`)

const seal = (database: string) =>
  SqlClient.SqlClient.use((sql) => sql`ALTER DATABASE ${sql(database)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`)

const dropTemplate = (database: string) =>
  SqlClient.SqlClient.use((sql) =>
    sql`ALTER DATABASE ${sql(database)} WITH IS_TEMPLATE false`.pipe(Effect.andThen(sql`DROP DATABASE IF EXISTS ${sql(database)}`))
  )

const dropDatabase = (database: string) => SqlClient.SqlClient.use((sql) => sql`DROP DATABASE IF EXISTS ${sql(database)} WITH (FORCE)`)

const connectionsTo = (database: string) =>
  SqlClient.SqlClient.use(
    (sql) => sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${database}`
  ).pipe(Effect.map((rows) => rows[0]?.n ?? 0))

export const docker = (options: Options): InfraSpec => {
  const name = InfraName.make(options.name ?? "postgres")
  const image = options.image ?? "postgres:18"
  const canClone = majorVersion(image) >= 18
  const copy: Copy = options.copy ?? (canClone ? "clone" : "full")
  const fail = (message: string) => new InfraError({ infra: name, message })
  const step =
    (label: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((error) => fail(`${label}: ${String(error)}`)))
  const onServer = <A, E>(serverPort: Port, label: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    onDatabase(serverPort, "postgres", effect).pipe(step(label))

  const databaseOf = (worktree: Worktree) => options.database?.(worktree) ?? databaseName(worktree.project, worktree.branch)
  const goldenOf = (worktree: Worktree) => databaseName(worktree.project, "golden")
  const sourceOf = (worktree: Worktree, golden: Golden) =>
    "snapshot" in golden ? databaseName(worktree.project, golden.snapshot.worktree) : undefined
  const isSnapshotSource = (worktree: Worktree, golden: Golden) => "snapshot" in golden && golden.snapshot.worktree === worktree.branch

  const migrateGolden = Effect.fn("Postgres.migrateGolden")(function* (
    serverPort: Port,
    golden: string,
    migrate: Run,
    worktree: Worktree,
    tools: InfraTools
  ) {
    yield* onServer(
      serverPort,
      "create golden",
      SqlClient.SqlClient.use((sql) => sql`CREATE DATABASE ${sql(golden)}`)
    )
    const url = yield* urlFor(serverPort, golden)
    yield* tools.exec({ name: "golden migrate", run: migrate, env: { DATABASE_URL: url }, cwd: worktree.root }).pipe(Effect.scoped)
  })

  const snapshotGolden = Effect.fn("Postgres.snapshotGolden")(function* (serverPort: Port, golden: string, source: string) {
    yield* Effect.annotateCurrentSpan({ "forkyard.db.source": source })
    if (!(yield* onServer(serverPort, "check snapshot source", exists(source))))
      return yield* fail(`the golden is a snapshot of ${source}, which does not exist yet. Start that worktree first.`)

    yield* Effect.acquireUseRelease(
      onServer(serverPort, `close ${source} for a moment`, closeTo(source)),
      () => onServer(serverPort, "snapshot golden", createFrom(golden, source)),
      () => onServer(serverPort, `reopen ${source}`, openTo(source)).pipe(Effect.orDie)
    )
  })

  const buildGolden = Effect.fn("Postgres.buildGolden")(
    function* (serverPort: Port, golden: Golden, worktree: Worktree, tools: InfraTools) {
      const template = goldenOf(worktree)
      const source = sourceOf(worktree, golden)
      if ("migrate" in golden) yield* migrateGolden(serverPort, template, toRun(golden.migrate), worktree, tools)
      if (source) yield* snapshotGolden(serverPort, template, source)
      yield* onServer(serverPort, "seal golden", seal(template))
    },
    (effect, serverPort, golden, worktree) =>
      effect.pipe(
        Effect.onError(() => onServer(serverPort, "drop unfinished golden", dropDatabase(goldenOf(worktree))).pipe(Effect.ignore)),
        Effect.tap(() =>
          Effect.logInfo(
            `[${name}] built golden ${goldenOf(worktree)} ${"migrate" in golden ? `by migrating, from ${worktree.id}` : `as a snapshot of ${sourceOf(worktree, golden)}`}`
          )
        )
      )
  )

  const ensureGolden = Effect.fn("Postgres.ensureGolden")(function* (
    serverPort: Port,
    golden: Golden,
    worktree: Worktree,
    tools: InfraTools
  ) {
    yield* Effect.annotateCurrentSpan({ "db.namespace": goldenOf(worktree), "forkyard.worktree": worktree.id })
    if (yield* onServer(serverPort, "check golden", sealed(goldenOf(worktree)))) return
    yield* onServer(serverPort, "drop unfinished golden", dropDatabase(goldenOf(worktree)))
    yield* buildGolden(serverPort, golden, worktree, tools)
  })

  const templateFor = (worktree: Worktree) => {
    if (!options.golden) return undefined
    if (isSnapshotSource(worktree, options.golden)) return undefined
    return goldenOf(worktree)
  }

  const createDatabase = Effect.fn("Postgres.createDatabase")(function* (serverPort: Port, database: string, template: string | undefined) {
    yield* Effect.annotateCurrentSpan({ "db.namespace": database, "forkyard.db.template": template ?? "", "forkyard.db.copy": copy })
    yield* onServer(
      serverPort,
      "create database",
      template ? createFrom(database, template) : SqlClient.SqlClient.use((sql) => sql`CREATE DATABASE ${sql(database)}`)
    )
  })

  const ensureDatabase = Effect.fnUntraced(function* (serverPort: Port, database: string, template: string | undefined) {
    if (yield* onServer(serverPort, "check database", exists(database))) return false
    yield* createDatabase(serverPort, database, template)
    return true
  })

  const warnIfClonesCopy = Effect.fn("Postgres.checkClone")(function* (container: string, tools: InfraTools) {
    const filesystem = yield* tools
      .exec({
        name: "volume filesystem",
        run: cmd("docker", "exec", container, "stat", "-f", "-c", "%T", "/var/lib/postgresql"),
        env: {},
        cwd: "/"
      })
      .pipe(
        Effect.scoped,
        Effect.map((output) => output.trim()),
        Effect.orElseSucceed(() => "unknown")
      )
    yield* Effect.annotateCurrentSpan({ "forkyard.db.volume_filesystem": filesystem })
    if (cloningFilesystems.includes(filesystem)) return
    yield* Effect.logWarning(
      `[${name}] copy is "clone" but the data volume is on ${filesystem}, which cannot share blocks: every worktree database will be a full copy`
    )
  })

  const start = Effect.fn("Postgres.start")(function* (instance: string, tools: InfraTools) {
    if (copy === "clone" && !canClone) return yield* fail(`copy "clone" needs Postgres 18 or newer, and the image is ${image}`)

    const container = yield* containerName(name, instance)
    const hostPort = yield* port(name)
    const published = yield* publish(hostPort, 5432)
    const cloneFlags = copy === "clone" ? ["-c", "file_copy_method=clone"] : []
    yield* Effect.annotateCurrentSpan({
      "db.system.name": "postgresql",
      "container.image.name": image,
      "server.port": hostPort,
      "forkyard.db.copy": copy
    })
    const started = yield* dockerContainer(tools, {
      infra: name,
      name: container,
      args: [
        "-p",
        published,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "-v",
        `${container}-data:${dataPath(image)}`,
        "--stop-signal",
        "SIGINT",
        image,
        ...cloneFlags
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
    if (copy === "clone") yield* warnIfClonesCopy(container, tools)
    return { port: hostPort, env: {}, routes: {} }
  })

  const serverPortOf = (server: InfraServer) => (server.port ? Effect.succeed(server.port) : Effect.fail(fail("server has no port")))

  const tenant = Effect.fn("Postgres.tenant")(function* (server: InfraServer, worktree: Worktree, tools: InfraTools) {
    const serverPort = yield* serverPortOf(server)
    const database = databaseOf(worktree)
    const template = templateFor(worktree)
    yield* Effect.annotateCurrentSpan({ "db.system.name": "postgresql", "db.namespace": database, "forkyard.worktree": worktree.id })
    if (template && options.golden) yield* server.exclusive(ensureGolden(serverPort, options.golden, worktree, tools))

    const created = yield* server.exclusive(ensureDatabase(serverPort, database, template))
    yield* Effect.annotateCurrentSpan({ "forkyard.db.created": created })

    const url = yield* urlFor(serverPort, database)
    const host = yield* dockerReach
    return options.env?.({ url, database, host, port: serverPort }) ?? { DATABASE_URL: url }
  })

  const refreshGolden = Effect.fn("Postgres.refreshGolden")(function* (server: InfraServer, worktree: Worktree, tools: InfraTools) {
    if (!options.golden) return yield* fail("this Postgres has no golden configured")
    const serverPort = yield* serverPortOf(server)
    const golden = options.golden
    yield* server.exclusive(
      onServer(serverPort, "drop old golden", dropTemplate(goldenOf(worktree))).pipe(
        Effect.andThen(buildGolden(serverPort, golden, worktree, tools))
      )
    )
    return `rebuilt ${goldenOf(worktree)}; new worktrees and reset databases start from it`
  })

  const resetDatabase = Effect.fn("Postgres.resetDatabase")(function* (server: InfraServer, worktree: Worktree, tools: InfraTools) {
    const serverPort = yield* serverPortOf(server)
    const database = databaseOf(worktree)
    const template = templateFor(worktree)
    if (options.golden && isSnapshotSource(worktree, options.golden))
      return yield* fail(`${database} is the snapshot source; it is never reset`)
    if (template && options.golden) yield* server.exclusive(ensureGolden(serverPort, options.golden, worktree, tools))
    yield* server.exclusive(
      onServer(serverPort, "drop database", dropDatabase(database)).pipe(Effect.andThen(createDatabase(serverPort, database, template)))
    )
    return `recreated ${database}${template ? ` from ${template}` : ""}; restart services that keep connections open`
  })

  const forget = Effect.fn("Postgres.forget")(function* (server: InfraServer, tenant: Worktree) {
    if (options.golden && isSnapshotSource(tenant, options.golden)) return false
    const serverPort = yield* serverPortOf(server)
    const database = databaseOf(tenant)
    if ((yield* onServer(serverPort, "count connections", connectionsTo(database))) > 0) return false
    yield* onServer(serverPort, "drop unused database", dropDatabase(database))
    return true
  })

  return {
    name,
    scope: options.scope,
    variant: variantOf(image),
    start,
    tenant,
    ...(options.reapAfter === false ? {} : { reap: { after: options.reapAfter ?? "7 days", forget } }),
    actions: { "refresh-golden": refreshGolden, "reset-database": resetDatabase }
  }
}
