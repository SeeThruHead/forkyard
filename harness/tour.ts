import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Clock, Console, Effect, FileSystem, Option, Path, Ref, Schedule, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ForkyardClient } from "../src/Client.ts"
import { defaultHome } from "../src/main-daemon.ts"
import { AbsolutePath, ownerOfWorktree, ServiceName, WorktreeId } from "../src/Ids.ts"
import { type EnvVar, isSettled, runOf, type Snapshot, type WorktreeView } from "../src/Model.ts"

type Target = { readonly app: string; readonly project: string; readonly branch: string }

const targets: ReadonlyArray<Target> = [
  { app: "storefront", project: "storefront", branch: "main" },
  { app: "storefront", project: "storefront", branch: "feat-gift-cards" },
  { app: "storefront", project: "storefront", branch: "fix-checkout" },
  { app: "bun-dotenv", project: "shortly", branch: "main" },
  { app: "bun-dotenv", project: "shortly", branch: "feat-tags" },
  { app: "python-compose", project: "taskboard", branch: "main" },
  { app: "python-compose", project: "taskboard", branch: "feat-due-dates" }
]

const idOf = (target: Target) => WorktreeId.make(`${target.branch}.${target.project}`)

const wt = (id: string) => WorktreeId.make(id)

const settled = (ids: ReadonlyArray<WorktreeId>) => (snapshot: Snapshot) => ids.every((id) => isSettled(snapshot[id]))

const apiRun = (snapshot: Snapshot, id: string) => {
  const view = snapshot[wt(id)]?.services[ServiceName.make("api")]
  return view ? runOf(view.state) : undefined
}

const apiReady = (snapshot: Snapshot, id: string) => snapshot[wt(id)]?.services[ServiceName.make("api")]?.state._tag === "Ready"

const url = (service: string, target: string) => `http://${service}.${target}.localhost`

const getJson = (address: string) =>
  Effect.tryPromise(() =>
    fetch(address).then((response) => (response.ok ? response.json() : Promise.reject(new Error(`${address} -> ${response.status}`))))
  ).pipe(Effect.retry(Schedule.spaced("250 millis").pipe(Schedule.upTo({ duration: "10 seconds" }))))

const statusOf = (address: string) => Effect.tryPromise(() => fetch(address).then((response) => response.status))

const postJson = (address: string, body: unknown) =>
  Effect.tryPromise(() =>
    fetch(address, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) =>
      response.json()
    )
  )

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = path.resolve(".")
  const home = process.env.FORKYARD_HOME ?? defaultHome
  const socket = path.join(home, "forkyard.sock")
  const checks = yield* Ref.make<ReadonlyArray<string>>([])
  const say = (line: string) => Console.log(line).pipe(Effect.andThen(Ref.update(checks, (all) => [...all, line])))
  const check = (label: string, ok: boolean, detail = "") => say(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`)
  const step = (title: string) => say(`\n== ${title}`)
  const run = (command: string, ...args: ReadonlyArray<string>) => spawner.string(ChildProcess.make(command, [...args], { cwd: root }))

  if (!(yield* fs.exists(socket))) return yield* Effect.fail(`forkyard is not running at ${socket}. Start it with: bin/forkyard daemon`)
  const forkyard = yield* ForkyardClient
  const snapshot = forkyard.Status().pipe(Stream.runHead, Effect.map(Option.getOrElse((): Snapshot => ({}))))
  const waitFor = (ids: ReadonlyArray<WorktreeId>, within: `${number} seconds`) =>
    forkyard.Status().pipe(Stream.filter(settled(ids)), Stream.runHead, Effect.map(Option.getOrThrow), Effect.timeout(within))
  const envOf = (id: string, service: string) => forkyard.Env({ id: wt(id), service: ServiceName.make(service) })
  const envVar = (vars: ReadonlyArray<EnvVar>, key: string) => vars.find((entry) => entry.key === key)

  yield* step("1. reset: stop old worktrees, drop the shared Postgres volume, copy fresh checkouts")
  const running = Object.keys(yield* snapshot).map(wt)
  yield* Effect.forEach(running, (id) => forkyard.Down({ id }), { discard: true })
  yield* Effect.sleep("3 seconds")
  yield* run("docker", "volume", "rm", "-f", "forkyard-postgres-shared-data").pipe(Effect.ignore)
  yield* fs.remove(path.join(home, "worktrees"), { recursive: true }).pipe(Effect.ignore)
  yield* Effect.forEach(
    targets,
    (target) =>
      Effect.gen(function* () {
        const dest = path.join(home, "worktrees", target.project, target.branch)
        yield* fs.makeDirectory(path.dirname(dest), { recursive: true })
        yield* run("cp", "-cR", path.join(root, "examples", target.app), dest)
        const overlay = path.join(root, "harness", "branches", target.project, target.branch)
        if (yield* fs.exists(overlay)) yield* run("cp", "-cR", `${overlay}/.`, dest)
      }),
    { discard: true }
  )
  yield* say(`    stopped ${running.length}, copied ${targets.length} checkouts into ${path.join(home, "worktrees")}`)

  const rootOf = (target: Target) => AbsolutePath.make(path.join(home, "worktrees", target.project, target.branch))
  const mains = targets.filter((target) => target.branch === "main")
  const branches = targets.filter((target) => target.branch !== "main")

  yield* step("2. forkyard up on main of each repo (builds the golden template), then every other branch at once")
  const firstStart = yield* Clock.currentTimeMillis
  yield* Effect.forEach(mains, (target) => forkyard.Up({ root: rootOf(target), branch: target.branch }), {
    discard: true,
    concurrency: "unbounded"
  })
  yield* waitFor(mains.map(idOf), "240 seconds")
  const mainsReady = yield* Clock.currentTimeMillis
  yield* Effect.forEach(branches, (target) => forkyard.Up({ root: rootOf(target), branch: target.branch }), {
    discard: true,
    concurrency: "unbounded"
  })
  const all = yield* waitFor(targets.map(idOf), "240 seconds")
  const allReady = yield* Clock.currentTimeMillis
  yield* say(
    `    main branches settled in ${((mainsReady - firstStart) / 1000).toFixed(1)} s (includes building the golden template and starting Temporal)`
  )
  yield* say(`    ${branches.length} more branches settled in ${((allReady - mainsReady) / 1000).toFixed(1)} s`)
  yield* Effect.forEach(
    Object.values(all) as ReadonlyArray<WorktreeView>,
    (worktree) =>
      say(
        `    ${worktree.id.padEnd(26)} ${Object.entries(worktree.services)
          .map(([name, service]) => `${name}:${service.state._tag.toLowerCase()}`)
          .join(" ")}`
      ),
    { discard: true }
  )

  yield* step("3. storefront: each branch has its own database, cloned from one golden template on one Postgres")
  const storefront = targets.filter((target) => target.project === "storefront")
  const infos = yield* Effect.forEach(storefront, (target) => getJson(`${url("api", idOf(target))}/api/info`))
  yield* Effect.forEach(
    infos,
    (info: any) =>
      say(
        `    ${String(info.branch).padEnd(13)} db ${info.database}, migrations ${info.migrations.join(" ")}, temporal ${info.temporal.address}`
      ),
    { discard: true }
  )
  yield* check("three different databases", new Set(infos.map((info: any) => info.database)).size === 3)
  yield* check(
    "feat-gift-cards ran its extra migration, main did not",
    infos[1].migrations.includes("003_gift_cards.sql") && !infos[0].migrations.includes("003_gift_cards.sql")
  )
  const giftCardsMain = yield* statusOf(`${url("api", "main.storefront")}/api/gift-cards`)
  const giftCardsBranch = yield* statusOf(`${url("api", "feat-gift-cards.storefront")}/api/gift-cards`)
  yield* check(
    "gift cards endpoint 404 on main, 200 on feat-gift-cards",
    giftCardsMain === 404 && giftCardsBranch === 200,
    `${giftCardsMain} / ${giftCardsBranch}`
  )
  const pgPorts = yield* Effect.forEach(
    [
      ["main.storefront", "api"],
      ["fix-checkout.storefront", "api"],
      ["main.shortly", "api"]
    ] as const,
    ([id, service]) =>
      envOf(id, service).pipe(Effect.map((vars) => new URL(envVar(vars, "DATABASE_URL")?.value ?? "postgres://x:1/y").port))
  )
  yield* check("storefront and shortly share one Postgres server", new Set(pgPorts).size === 1, `port ${pgPorts[0]}`)

  yield* step("4. write on one branch, read on the others")
  yield* postJson(`${url("api", "feat-gift-cards.storefront")}/api/orders`, { productId: 1, note: "Placed on feat-gift-cards by the tour" })
  const orders = yield* Effect.forEach(storefront, (target) => getJson(`${url("api", idOf(target))}/api/orders`))
  yield* check(
    "order visible on feat-gift-cards only",
    orders[1].length === 1 && orders[0].length === 0 && orders[2].length === 0,
    orders.map((list: any) => list.length).join(" / ")
  )

  yield* step("5. Temporal per branch: a job runs on its own branch's worker and server")
  yield* check("three Temporal servers", new Set(infos.map((info: any) => info.temporal.address)).size === 3)
  yield* check(
    "each has the three namespaces",
    infos.every((info: any) => ["orders", "fulfillment", "notifications"].every((name) => info.temporal.namespaces.includes(name)))
  )
  yield* postJson(`${url("api", "fix-checkout.storefront")}/api/jobs`, { kind: "recount inventory" })
  const done = yield* getJson(`${url("api", "fix-checkout.storefront")}/api/jobs`).pipe(
    Effect.filterOrFail((actions: any) => actions[0]?.status === "done"),
    Effect.retry(Schedule.spaced("300 millis").pipe(Schedule.upTo({ duration: "10 seconds" })))
  )
  yield* check("fix-checkout's workers ran it", String(done[0].done_by).includes(infos[2].temporal.address), done[0].done_by)
  const mainActions = yield* getJson(`${url("api", "main.storefront")}/api/jobs`)
  yield* check("main never saw it", mainActions.length === 0)

  yield* step("6. env: what forkyard replaced, what passed through, what it flagged")
  const apiEnv = yield* envOf("feat-gift-cards.storefront", "api")
  const show = (key: string) => {
    const entry = envVar(apiEnv, key)
    return say(
      `    ${key.padEnd(22)} ${String(entry?.source).padEnd(15)} ${entry?.value}${entry?.replaced ? `   (was ${entry.replaced})` : ""}${entry?.warning ? "   [flagged]" : ""}`
    )
  }
  yield* Effect.forEach(
    ["DATABASE_URL", "API_URL", "API_GRAPHQL_URL", "TEMPORAL_ADDRESS", "AUTH_ISSUER_URL", "PAYMENTS_SECRET_KEY", "ANALYTICS_HOST"],
    show,
    { discard: true }
  )
  yield* check(
    "DATABASE_URL replaced the schema default",
    envVar(apiEnv, "DATABASE_URL")?.replaced?.includes("localhost:5432/storefront") ?? false
  )
  yield* check(
    "API_GRAPHQL_URL re-derived by varlock from forkyard's API_URL",
    envVar(apiEnv, "API_GRAPHQL_URL")?.value === `${url("api", "feat-gift-cards.storefront")}/graphql`
  )
  const pools = yield* Effect.forEach(storefront, (target) =>
    envOf(idOf(target), "api").pipe(Effect.map((vars) => envVar(vars, "AUTH_ISSUER_URL")?.value))
  )
  yield* check(
    "Auth issuer from the secret manager passed through unchanged on every branch",
    new Set(pools).size === 1 && pools[0] === "https://auth.example.dev/realms/storefront-dev"
  )
  yield* check("ANALYTICS_HOST flagged as a fixed port", envVar(apiEnv, "ANALYTICS_HOST")?.warning !== undefined)
  yield* check("PAYMENTS_SECRET_KEY masked", envVar(apiEnv, "PAYMENTS_SECRET_KEY")?.value.includes("****") ?? false)

  yield* step("7. shortly (Bun, .env files, Redis per branch)")
  yield* postJson(`${url("api", "feat-tags.shortly")}/api/links`, { target: "https://example.com/feat-tags" })
  const links = yield* getJson(`${url("api", "feat-tags.shortly")}/api/links`).pipe(
    Effect.filterOrFail((list: any) => Boolean(list[0]?.checked_by)),
    Effect.retry(Schedule.spaced("300 millis").pipe(Schedule.upTo({ duration: "10 seconds" })))
  )
  const mainLinks = yield* getJson(`${url("api", "main.shortly")}/api/links`)
  yield* check("link checked by feat-tags' own worker, main has none", links.length === 1 && mainLinks.length === 0, links[0].checked_by)
  const redis = yield* Effect.forEach(["main.shortly", "feat-tags.shortly"], (id) =>
    envOf(id, "api").pipe(Effect.map((vars) => envVar(vars, "REDIS_URL")?.value))
  )
  yield* check("each branch has its own Redis", redis[0] !== redis[1], redis.join(" vs "))
  const shortlyEnv = yield* envOf("feat-tags.shortly", "api")
  yield* check(".env.local wins over .env", envVar(shortlyEnv, "LINK_TTL_DAYS")?.value === "7")
  yield* check("ANALYTICS_URL flagged", envVar(shortlyEnv, "ANALYTICS_URL")?.warning !== undefined)

  yield* step("8. taskboard (Python, docker compose env, SQLite per branch)")
  yield* postJson(`${url("api", "feat-due-dates.taskboard")}/api/tasks`, { title: "Add due dates" })
  const tasks = yield* getJson(`${url("api", "feat-due-dates.taskboard")}/api/tasks`).pipe(
    Effect.filterOrFail((list: any) => Boolean(list[0]?.estimated_by)),
    Effect.retry(Schedule.spaced("300 millis").pipe(Schedule.upTo({ duration: "10 seconds" })))
  )
  const mainTasks = yield* getJson(`${url("api", "main.taskboard")}/api/tasks`)
  yield* check(
    "task estimated by feat-due-dates' worker, main has none",
    tasks.length === 1 && mainTasks.length === 0,
    tasks[0].estimated_by
  )
  const webEnv = yield* envOf("feat-due-dates.taskboard", "web")
  yield* check(
    "compose's http://api:8000 replaced",
    envVar(webEnv, "API_URL")?.replaced === "http://api:8000",
    envVar(webEnv, "API_URL")?.value
  )
  const taskboardApiEnv = yield* envOf("feat-due-dates.taskboard", "api")
  yield* check(
    "compose env_file and interpolation came through",
    envVar(taskboardApiEnv, "APP_NAME")?.value === "Taskboard" && envVar(taskboardApiEnv, "LOG_LEVEL")?.value === "debug"
  )

  yield* step("9. restart api on fix-checkout only")
  const before = yield* snapshot
  const others = (snap: Snapshot): ReadonlyArray<number | undefined> =>
    ["main.storefront", "feat-gift-cards.storefront"].map((id) => apiRun(snap, id)?.pid)
  const oldInfo: any = infos[2]
  yield* forkyard.Restart({ id: wt("fix-checkout.storefront"), service: ServiceName.make("api") })
  yield* forkyard.Status().pipe(
    Stream.filter(
      (snap) =>
        (apiRun(snap, "fix-checkout.storefront")?.run ?? 0) > (apiRun(before, "fix-checkout.storefront")?.run ?? 0) &&
        apiReady(snap, "fix-checkout.storefront")
    ),
    Stream.runHead,
    Effect.timeout("30 seconds")
  )
  const newInfo: any = yield* getJson(`${url("api", "fix-checkout.storefront")}/api/info`)
  const after = yield* snapshot
  yield* check(
    "new pid and port, same name",
    newInfo.pid !== oldInfo.pid && newInfo.port !== oldInfo.port,
    `pid ${oldInfo.pid} -> ${newInfo.pid}, port ${oldInfo.port} -> ${newInfo.port}`
  )
  yield* check("other branches' api untouched", others(before).join() === others(after).join())
  const runs = yield* forkyard.Runs({ owner: ownerOfWorktree(wt("fix-checkout.storefront")), service: "api" })
  const previous = yield* forkyard.RunLog({ runId: runs[1]!.id }).pipe(Stream.runCollect)
  yield* check("previous run's log still readable", runs.length >= 2 && previous.length > 0, `run #${runs[1]?.n}: ${previous.length} lines`)

  yield* step("10. telemetry: everything above landed in Maple")
  const mapleUrl = `http://127.0.0.1:${process.env.FORKYARD_MAPLE_PORT ?? "14418"}`
  yield* Effect.tryPromise(() => fetch(url("shop", "feat-gift-cards.storefront")).then((response) => response.text()))
  const query = (sql: string) =>
    Effect.tryPromise(() =>
      fetch(`${mapleUrl}/local/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql })
      }).then((response) => response.json() as Promise<ReadonlyArray<Record<string, unknown>>>)
    )
  const count = (sql: string) => query(sql).pipe(Effect.map((rows) => Number(rows[0]?.n ?? 0)))
  const eventually = (sql: string) =>
    count(sql).pipe(
      Effect.filterOrFail((n) => n > 0),
      Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "25 seconds" }))),
      Effect.orElseSucceed(() => 0)
    )
  const serviceRunTrace = yield* eventually(`
    SELECT count() AS n FROM (
      SELECT TraceId FROM traces WHERE ServiceName = 'forkyard'
      GROUP BY TraceId
      HAVING countIf(SpanName = 'Supervisor.startService' AND SpanAttributes['forkyard.worktree'] = 'feat-gift-cards.storefront' AND SpanAttributes['forkyard.service'] = 'api') > 0
        AND countIf(SpanName = 'Env.resolve') > 0
        AND countIf(SpanName = 'EnvSource.load') > 0
        AND countIf(SpanName = 'Proc.spawn') > 0
        AND countIf(SpanName = 'Supervisor.waitHealthy') > 0
    )`)
  yield* check(
    "a service run is one trace: env, spawn, health",
    serviceRunTrace > 0,
    `${serviceRunTrace} traces for the api on feat-gift-cards`
  )
  const attributed = yield* count(
    `SELECT count() AS n FROM traces WHERE ServiceName = 'forkyard' AND SpanAttributes['forkyard.worktree'] = 'feat-gift-cards.storefront'`
  )
  yield* check("daemon spans carry the worktree", attributed > 0, `${attributed} spans for feat-gift-cards.storefront`)
  const noteLogs = yield* eventually(
    `SELECT count() AS n FROM logs WHERE ServiceName = 'api' AND ResourceAttributes['service.namespace'] = 'feat-gift-cards.storefront' AND Body LIKE 'order % placed%'`
  )
  yield* check("api's output arrived as logs under its branch", noteLogs > 0)
  const linked = yield* count(
    `SELECT count() AS n FROM logs WHERE ServiceName = 'api' AND ResourceAttributes['service.namespace'] = 'feat-gift-cards.storefront' AND TraceId != ''`
  )
  yield* check("those logs link to the run's trace", linked > 0, `${linked} lines with a trace id`)
  const distributed = yield* eventually(`
    SELECT count() AS n FROM (
      SELECT TraceId FROM traces WHERE ResourceAttributes['service.namespace'] = 'feat-gift-cards.storefront'
      GROUP BY TraceId
      HAVING countIf(ServiceName = 'shop') > 0 AND countIf(ServiceName = 'api') > 0 AND countIf(SpanName LIKE 'pg%') > 0
    )`)
  yield* check("one trace spans shop, api and Postgres", distributed > 0, `${distributed} traces`)
  const ownDatabase = yield* count(
    `SELECT count() AS n FROM traces WHERE ServiceName = 'api' AND ResourceAttributes['service.namespace'] = 'feat-gift-cards.storefront' AND SpanAttributes['db.name'] = 'storefront_feat_gift_cards'`
  )
  const leaked = yield* count(
    `SELECT count() AS n FROM traces WHERE ResourceAttributes['service.namespace'] != 'feat-gift-cards.storefront' AND SpanAttributes['db.name'] = 'storefront_feat_gift_cards'`
  )
  yield* check(
    "only feat-gift-cards' services touched feat-gift-cards' database",
    ownDatabase > 0 && leaked === 0,
    `${ownDatabase} own spans, ${leaked} from other branches`
  )
  const starts = yield* eventually(
    `SELECT count() AS n FROM metrics_sum WHERE ServiceName = 'forkyard' AND MetricName = 'forkyard.process.starts'`
  )
  const ready = yield* eventually(
    `SELECT count() AS n FROM metrics_histogram WHERE ServiceName = 'forkyard' AND MetricName = 'forkyard.service.ready_ms'`
  )
  yield* check(
    "daemon metrics exported",
    starts > 0 && ready > 0,
    `forkyard.process.starts ${starts} points, forkyard.service.ready_ms ${ready} points`
  )
  const bunLogs = yield* eventually(
    `SELECT count() AS n FROM logs WHERE ServiceName = 'worker' AND ResourceAttributes['service.namespace'] = 'feat-tags.shortly' AND Body LIKE 'checked link%'`
  )
  const pythonLogs = yield* eventually(
    `SELECT count() AS n FROM logs WHERE ServiceName = 'worker' AND ResourceAttributes['service.namespace'] = 'feat-due-dates.taskboard' AND Body LIKE 'estimated task%'`
  )
  yield* check("Bun and Python apps have logs without any OTel SDK", bunLogs > 0 && pythonLogs > 0)

  const lines = yield* Ref.get(checks)
  const failed = lines.filter((line) => line.startsWith("FAIL")).length
  yield* say(`\n${lines.filter((line) => line.startsWith("ok")).length} checks passed, ${failed} failed`)
  yield* say(`tour: http://forkyard.localhost/#/tour/1, telemetry: http://maple.localhost`)
  yield* fs.writeFileString(path.join(home, "tour-output.txt"), (yield* Ref.get(checks)).join("\n") + "\n")
  if (failed > 0) return yield* Effect.fail(`${failed} checks failed`)
})

program.pipe(
  Effect.scoped,
  Effect.provide(ForkyardClient.layer(`${process.env.FORKYARD_HOME ?? defaultHome}/forkyard.sock`)),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
