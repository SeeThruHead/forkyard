import { Effect } from "effect"
import { cmd, type Env, type InfraServer, type InfraSpec, type InfraTools, type Worktree } from "../Stack.ts"
import { port, readyOrExit } from "./Shared.ts"

export type RedisTenant = { readonly url: string; readonly prefix: string }

type Options = {
  readonly name?: string
  readonly scope: "shared" | "worktree"
  readonly env?: (redis: RedisTenant) => Env
}

export const native = (options: Options): InfraSpec => {
  const name = options.name ?? "redis"

  const start = Effect.fn("Redis.start")(function*(_instance: string, tools: InfraTools) {
    const listen = yield* port(name)
    yield* Effect.annotateCurrentSpan({ "db.system.name": "redis", "server.port": listen })
    const started = yield* tools.spawn({
      name,
      run: cmd("redis-server", "--port", String(listen), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"),
      env: {}
    })
    const ping = tools.exec({ name: "redis-cli", run: cmd("redis-cli", "-p", String(listen), "ping"), env: {}, cwd: "/" }).pipe(Effect.scoped)
    yield* readyOrExit(name, started, ping, "15 seconds")
    return { port: listen, env: {}, routes: {} }
  })

  const tenant = Effect.fn("Redis.tenant")(function*(server: InfraServer, worktree: Worktree) {
    const redis: RedisTenant = {
      url: `redis://127.0.0.1:${server.port}`,
      prefix: options.scope === "shared" ? `${worktree.id}:` : ""
    }
    yield* Effect.annotateCurrentSpan({ "db.system.name": "redis", "server.port": server.port, "forkyard.redis.prefix": redis.prefix })
    return options.env?.(redis) ?? { REDIS_URL: redis.url, REDIS_PREFIX: redis.prefix }
  })

  return { name, scope: options.scope, start, tenant }
}
