import { cmd, Env, Infra, make, Postgres, Redis, Service, url } from "forkyard"
import { Effect } from "effect"

const bun = (file: string) => cmd("bun", file)

export default make(
  "shortly",
  Effect.gen(function*() {
    const postgres = yield* Infra(Postgres.docker({ scope: "shared" }))
    const redis = yield* Infra(Redis.native({ scope: "worktree" }))

    const envFrom = [Env.dotenv(".env", ".env.local")]
    const routing = { API_URL: yield* url("api"), WEB_URL: yield* url("web") }

    const migrate = yield* Service.task("migrate", { cwd: "apps/api", run: bun("migrate.ts"), uses: [postgres], envFrom })
    const api = yield* Service.http("api", { cwd: "apps/api", run: bun("server.ts"), uses: [postgres, redis], after: [migrate], env: routing, envFrom })
    yield* Service.worker("worker", { cwd: "apps/worker", run: bun("worker.ts"), uses: [postgres, redis], after: [migrate], envFrom })
    yield* Service.http("web", { cwd: "apps/web", run: bun("server.ts"), after: [api], env: routing, envFrom })
  })
)
