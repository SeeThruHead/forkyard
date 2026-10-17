import { Env, Infra, logLine, make, node, Postgres, Service, Temporal, url, watch } from "forkyard"
import { Effect } from "effect"

export default make(
  "dispatch",
  Effect.gen(function* () {
    const postgres = yield* Infra(Postgres.docker({ scope: "shared", golden: { migrate: node("packages/db/migrate.ts") } }))
    const temporal = yield* Infra(Temporal.dev({ scope: "worktree", namespaces: ["dispatch", "billing", "notifications"] }))

    const envFrom = [Env.dotenv(".env")]
    const env = {
      API_URL: yield* url("api"),
      GATEWAY_URL: yield* url("gateway"),
      CONSOLE_URL: yield* url("console")
    }

    yield* Service.task("codegen", {
      run: node("packages/db/codegen.ts"),
      watch: watch("packages/db/migrations/**")
    })

    const migrate = yield* Service.task("migrate", {
      run: node("packages/db/migrate.ts"),
      uses: [postgres],
      envFrom,
      watch: watch("packages/db/migrations/**")
    })

    const api = yield* Service.http("api", {
      run: "pnpm --filter @dispatch/api run dev",
      uses: [postgres, temporal],
      after: [migrate],
      env,
      envFrom
    })

    const gateway = yield* Service.http("gateway", {
      run: node("apps/gateway/src/main.ts"),
      after: [api],
      env,
      envFrom,
      watch: watch("apps/gateway/src/**")
    })

    yield* Service.http("console", {
      run: "pnpm --filter @dispatch/console run dev",
      health: "/",
      after: [gateway],
      env
    })

    const worker = (name: string, script: string) =>
      Service.worker(name, {
        run: `pnpm --filter @dispatch/workers run ${script}`,
        uses: [postgres, temporal],
        after: [migrate],
        envFrom,
        ready: logLine(/worker ready/),
        watch: watch("apps/workers/src/**", "packages/workflows/src/**")
      })

    yield* worker("dispatch-worker", "dispatch")
    yield* worker("billing-worker", "billing")
    yield* worker("notifications-worker", "notifications")

    yield* Service.task("schedules", {
      run: "pnpm --filter @dispatch/scheduler run register",
      uses: [temporal],
      envFrom
    })
  })
)
