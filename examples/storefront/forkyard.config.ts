import { Env, Infra, make, node, Postgres, Service, Temporal, url, watch } from "forkyard"
import { Effect } from "effect"

export default make(
  "storefront",
  Effect.gen(function* () {
    const postgres = yield* Infra(Postgres.docker({ scope: "shared", golden: { migrate: node("packages/db/migrate.ts") } }))
    const temporal = yield* Infra(Temporal.dev({ scope: "worktree", namespaces: ["orders", "fulfillment", "notifications"] }))

    const env = {
      API_URL: yield* url("api"),
      SHOP_URL: yield* url("shop"),
      BACKOFFICE_URL: yield* url("backoffice")
    }
    const envFrom = [Env.varlock()]
    const shared = "packages/ui/**"

    const migrate = yield* Service.task("migrate", {
      run: node("packages/db/migrate.ts"),
      uses: [postgres],
      envFrom,
      watch: watch("packages/db/migrations/**")
    })

    const api = yield* Service.http("api", {
      run: "pnpm --filter @storefront/api run dev",
      uses: [postgres, temporal],
      after: [migrate],
      env,
      envFrom,
      watch: watch("apps/api/**", shared)
    })

    yield* Service.worker("workers", {
      run: "pnpm --filter @storefront/workers run dev",
      uses: [postgres, temporal],
      after: [migrate],
      env,
      envFrom,
      watch: watch("apps/workers/**")
    })

    yield* Service.http("reports", {
      run: "pnpm --filter @storefront/reports run dev",
      uses: [postgres],
      after: [migrate],
      envFrom,
      watch: watch("apps/reports/src/**")
    })

    yield* Service.http("shop", {
      run: "pnpm --filter @storefront/shop run dev",
      after: [api],
      env,
      envFrom,
      watch: watch("apps/shop/**", shared)
    })
    yield* Service.http("backoffice", {
      run: "pnpm --filter @storefront/backoffice run dev",
      uses: [temporal],
      after: [api],
      env,
      envFrom,
      watch: watch("apps/backoffice/**", shared)
    })
  })
)
