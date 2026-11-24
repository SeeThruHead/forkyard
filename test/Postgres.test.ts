import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Exit, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { AbsolutePath, BranchSlug, Port, ProjectName, WorktreeId } from "../src/Ids.ts"
import * as Postgres from "../src/infra/Postgres.ts"
import type { InfraServer, InfraTools, Worktree } from "../src/Stack.ts"

const testPort = process.env.FORKYARD_TEST_POSTGRES_PORT

const port = Port.make(Number(testPort ?? "5432"))

const server: InfraServer = { port, env: {}, routes: {}, instance: "postgres", urls: {}, exclusive: (effect) => effect }

const tools: InfraTools = { spawn: () => Effect.die("not used"), exec: () => Effect.die("not used") }

const worktreeOf = (project: string, branch: string): Worktree => ({
  id: WorktreeId.make(`${branch}.${project}`),
  project: ProjectName.make(project),
  branch: BranchSlug.make(branch),
  root: AbsolutePath.make("/repo"),
  profile: "default",
  domain: `${branch}.${project}.localhost`,
  proxyPort: Port.make(80)
})

const onDatabase = (database: string) => PgClient.layer({ url: Redacted.make(`postgres://postgres@127.0.0.1:${port}/${database}`) })

const databases = (project: string) =>
  SqlClient.SqlClient.use(
    (sql) =>
      sql<{
        readonly datname: string
        readonly datistemplate: boolean
      }>`SELECT datname, datistemplate FROM pg_database WHERE datname LIKE ${`${project}%`} OR datname LIKE ${`custom_${project}%`} ORDER BY datname`
  ).pipe(Effect.provide(onDatabase("postgres")))

const uniqueProject = (label: string) => Clock.currentTimeMillis.pipe(Effect.map((now) => `${label}${now.toString(36)}`))

const snapshotOfMain = { snapshot: { worktree: "main" } } as const

describe.skipIf(!testPort)("postgres against a real server (FORKYARD_TEST_POSTGRES_PORT)", () => {
  it.live(
    "keeps the golden template apart from a worktree on a branch named golden",
    () =>
      Effect.gen(function* () {
        const project = yield* uniqueProject("goldenns")
        const spec = Postgres.docker({ scope: "shared", golden: snapshotOfMain })
        yield* spec.tenant(server, worktreeOf(project, "main"), tools)
        yield* spec.tenant(server, worktreeOf(project, "golden"), tools)

        expect(yield* databases(project)).toEqual([
          { datname: `${project}__golden`, datistemplate: true },
          { datname: `${project}_golden`, datistemplate: false },
          { datname: `${project}_main`, datistemplate: false }
        ])
      }).pipe(Effect.scoped),
    60_000
  )

  it.live(
    "finds the snapshot source by the same rule that names worktree databases",
    () =>
      Effect.gen(function* () {
        const project = yield* uniqueProject("custom")
        const spec = Postgres.docker({
          scope: "shared",
          golden: snapshotOfMain,
          database: (worktree) => `custom_${worktree.project}_${worktree.branch}`
        })
        yield* spec.tenant(server, worktreeOf(project, "main"), tools)
        const feature = yield* spec.tenant(server, worktreeOf(project, "feature"), tools).pipe(Effect.exit)

        expect(Exit.isSuccess(feature)).toBe(true)
      }).pipe(Effect.scoped),
    60_000
  )

  it.live(
    "snapshots a source that has open sessions, and reopens it afterwards",
    () =>
      Effect.gen(function* () {
        const project = yield* uniqueProject("busy")
        const spec = Postgres.docker({ scope: "shared", golden: snapshotOfMain })
        yield* spec.tenant(server, worktreeOf(project, "main"), tools)
        yield* SqlClient.SqlClient.use((sql) => sql`SELECT pg_sleep(3)`).pipe(
          Effect.provide(onDatabase(`${project}_main`)),
          Effect.ignore,
          Effect.forkScoped
        )
        yield* Effect.sleep("300 millis")
        yield* spec.tenant(server, worktreeOf(project, "feature"), tools)
        const reopened = yield* SqlClient.SqlClient.use((sql) => sql`SELECT 1 AS ok`).pipe(
          Effect.provide(onDatabase(`${project}_main`)),
          Effect.exit
        )

        expect(Exit.isSuccess(reopened)).toBe(true)
      }).pipe(Effect.scoped),
    60_000
  )

  it.live(
    "automatic reaping leaves a database that has a session",
    () =>
      Effect.gen(function* () {
        const project = yield* uniqueProject("reap")
        const spec = Postgres.docker({ scope: "shared" })
        const feature = worktreeOf(project, "feature")
        yield* spec.tenant(server, feature, tools)
        yield* SqlClient.SqlClient.use((sql) => sql`SELECT pg_sleep(3)`).pipe(
          Effect.provide(onDatabase(`${project}_feature`)),
          Effect.ignore,
          Effect.forkScoped
        )
        yield* Effect.sleep("300 millis")
        const forgotten = yield* spec.reap!.forget(server, feature, tools)

        expect(forgotten).toBe(false)
        expect((yield* databases(project)).map((row) => row.datname)).toEqual([`${project}_feature`])
      }).pipe(Effect.scoped),
    60_000
  )
})
