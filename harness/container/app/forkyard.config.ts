import { Env, make, node, Service, url } from "forkyard"
import { Effect } from "effect"

export default make(
  "boxed",
  Effect.gen(function* () {
    const envFrom = [Env.dotenv(".env")]
    const migrate = yield* Service.task("migrate", { run: node("migrate.ts"), envFrom })
    const api = yield* Service.http("api", { run: node("api.ts"), after: [migrate], envFrom })
    yield* Service.http("web", { run: node("web.ts"), after: [api], envFrom, env: { API_URL: yield* url("api") } })
  })
)
