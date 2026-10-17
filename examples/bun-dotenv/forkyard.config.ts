import { bun, Env, Infra, make, Postgres, Redis, Service, url, watch } from "forkyard"
import { Effect } from "effect"

export default make(
  "shortly",
  Effect.gen(function* () {
    const postgres = yield* Infra(Postgres.docker({ scope: "shared" }))
    const redis = yield* Infra(Redis.native({ scope: "worktree" }))

    const envFrom = [Env.dotenv(".env", ".env.local")]
    const env = { API_URL: yield* url("api"), WEB_URL: yield* url("web") }

    const migrate = yield* Service.task("migrate", {
      cwd: "apps/api",
      run: "bun run migrate",
      uses: [postgres],
      envFrom,
      watch: watch("apps/api/migrate.ts")
    })

    const api = yield* Service.http("api", {
      cwd: "apps/api",
      run: "bun run dev",
      uses: [postgres, redis],
      after: [migrate],
      env,
      envFrom,
      watch: watch("apps/api/**", "packages/shared/**")
    })

    yield* Service.worker("worker", {
      cwd: "apps/worker",
      run: bun("worker.ts"),
      watch: watch("apps/worker/**", "packages/shared/**"),
      uses: [postgres, redis],
      after: [migrate],
      envFrom
    })
    yield* Service.http("web", {
      cwd: "apps/web",
      run: "bun run dev",
      after: [api],
      env,
      envFrom,
      watch: watch("apps/web/**", "packages/shared/**")
    })
  })
)
