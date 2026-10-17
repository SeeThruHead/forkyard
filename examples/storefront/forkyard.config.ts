import { Env, Infra, make, node, Postgres, Service, Temporal, url } from "forkyard"
import { Effect } from "effect"

export default make(
  "storefront",
  Effect.gen(function* () {
    const postgres = yield* Infra(Postgres.docker({ scope: "shared", golden: { migrate: node("packages/db/migrate.mjs") } }))
    const temporal = yield* Infra(Temporal.dev({ scope: "worktree", namespaces: ["orders", "fulfillment", "notifications"] }))

    const routing = {
      API_URL: yield* url("api"),
      SHOP_URL: yield* url("shop"),
      BACKOFFICE_URL: yield* url("backoffice")
    }
    const envFrom = [Env.varlock()]
    const otel = {
      NODE_OPTIONS: "--import @opentelemetry/auto-instrumentations-node/register",
      OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http,undici,pg",
      OTEL_LOGS_EXPORTER: "none"
    }
    const env = { ...routing, ...otel }

    const migrate = yield* Service.task("migrate", { run: node("packages/db/migrate.mjs"), uses: [postgres], env: otel, envFrom })

    const api = yield* Service.http("api", {
      cwd: "apps/api",
      run: node("server.mjs"),
      uses: [postgres, temporal],
      after: [migrate],
      env,
      envFrom
    })

    yield* Service.worker("workers", {
      cwd: "apps/workers",
      run: node("worker.mjs"),
      uses: [postgres, temporal],
      after: [migrate],
      env,
      envFrom
    })

    yield* Service.http("shop", { cwd: "apps/shop", run: node("server.mjs"), after: [api], env, envFrom })
    yield* Service.http("backoffice", { cwd: "apps/backoffice", run: node("server.mjs"), uses: [temporal], after: [api], env, envFrom })
  })
)
