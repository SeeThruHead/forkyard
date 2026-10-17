import { Infra, make, node, Postgres, Service } from "forkyard"
import { Effect } from "effect"

export default make(
  "boxedpg",
  Effect.gen(function* () {
    const postgres = yield* Infra(Postgres.docker({ scope: "shared" }))
    yield* Service.http("api", { run: node("api.ts"), uses: [postgres] })
  })
)
