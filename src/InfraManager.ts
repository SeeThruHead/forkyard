import { Context, Effect, Layer, RcMap, Ref, Semaphore, type Scope } from "effect"
import { Proc } from "./Proc.ts"
import { Router } from "./Router.ts"
import { type Env, InfraError, type InfraServer, type InfraSpec, type InfraTools, type Worktree } from "./Stack.ts"

const instanceOf = (spec: InfraSpec, worktree: Worktree) => (spec.scope === "shared" ? "shared" : worktree.id)

const toInfraError = (name: string) => (error: { readonly message: string }) => new InfraError({ infra: name, message: error.message })

export const toolsFor = (proc: Context.Service.Shape<typeof Proc>, instance: string): InfraTools => ({
  spawn: (spawn) =>
    proc
      .spawn({ worktree: `infra:${instance}`, service: spawn.name, run: spawn.run, env: spawn.env, cwd: spawn.cwd ?? process.cwd() })
      .pipe(
        Effect.map((spawned) => ({ pid: spawned.pid, exited: spawned.exited, output: spawned.output })),
        Effect.mapError(toInfraError(spawn.name))
      ),
  exec: (exec) =>
    proc
      .exec({ worktree: `infra:${instance}`, service: exec.name, run: exec.run, env: exec.env, cwd: exec.cwd })
      .pipe(Effect.mapError(toInfraError(exec.name)))
})

export type InfraLease = {
  readonly env: Env
  readonly server: InfraServer
}

export class InfraManager extends Context.Service<InfraManager, {
  readonly acquire: (spec: InfraSpec, worktree: Worktree) => Effect.Effect<InfraLease, InfraError, Scope.Scope>
  readonly running: Effect.Effect<ReadonlyArray<string>>
  readonly tools: (instance: string) => InfraTools
}>()("forkyard/InfraManager") {
  static readonly layer = (options: { readonly domain: string; readonly proxyPort: number }) =>
    Layer.effect(
      InfraManager,
      Effect.gen(function*() {
        const specs = yield* Ref.make<Readonly<Record<string, InfraSpec>>>({})
        const proc = yield* Proc
        const router = yield* Router
        const tools = (instance: string) => toolsFor(proc, instance)

        const hostFor = (name: string, route: string, instance: string) =>
          instance === "shared" ? `${route}.${options.domain}` : `${route}.${instance}.${options.domain}`

        const urlFor = (host: string) => `http://${host}${options.proxyPort === 80 ? "" : `:${options.proxyPort}`}`

        const servers = yield* RcMap.make({
          lookup: Effect.fn("InfraManager.start", { root: true })(function*(key: string) {
              const [name, instance] = key.split("|") as [string, string]
              const spec = (yield* Ref.get(specs))[name]
              if (!spec) return yield* new InfraError({ infra: name, message: "unknown infra" })
              yield* Effect.annotateCurrentSpan({ "forkyard.infra": name, "forkyard.infra.instance": instance, "forkyard.infra.scope": spec.scope })
              yield* Effect.logInfo(`infra ${name} starting for ${instance}`)
              yield* Effect.addFinalizer(() => Effect.logInfo(`infra ${name} stopped for ${instance}`))
              const started = yield* spec.start(instance, tools(instance))
              const urls = Object.fromEntries(
                Object.entries(started.routes).map(([route]) => [route, urlFor(hostFor(name, route, instance))])
              )
              yield* Effect.forEach(
                Object.entries(started.routes),
                ([route, port]) => router.expose({ host: hostFor(name, route, instance), port }),
                { discard: true }
              )
              const lock = yield* Semaphore.make(1)
              const server: InfraServer = { ...started, instance, urls, exclusive: (effect) => lock.withPermit(effect) }
              return server
            }),
          idleTimeToLive: "1 second"
        })

        const acquire = Effect.fn("InfraManager.acquire")(function*(spec: InfraSpec, worktree: Worktree) {
          yield* Effect.annotateCurrentSpan({ "forkyard.infra": spec.name, "forkyard.infra.scope": spec.scope, "forkyard.worktree": worktree.id })
          yield* Ref.update(specs, (all) => ({ ...all, [spec.name]: spec }))
          const instance = instanceOf(spec, worktree)
          const server = yield* RcMap.get(servers, `${spec.name}|${instance}`)
          const env = yield* spec.tenant(server, worktree, tools(instance)).pipe(
            Effect.withSpan("InfraSpec.tenant", { attributes: { "forkyard.infra": spec.name, "forkyard.worktree": worktree.id } })
          )
          return { env, server } satisfies InfraLease
        })

        return InfraManager.of({
          acquire,
          tools,
          running: RcMap.keys(servers).pipe(Effect.map((keys) => [...keys]))
        })
      })
    )
}
