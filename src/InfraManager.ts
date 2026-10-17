import { Context, Effect, Layer, RcMap, Ref, Semaphore, type Scope } from "effect"
import { type InfraName, ownerOfInfra, Pid, type Port } from "./Ids.ts"
import { Proc } from "./Proc.ts"
import { Router } from "./Router.ts"
import { type Env, InfraError, type InfraServer, type InfraSpec, type InfraStarted, type InfraTools, type Worktree } from "./Stack.ts"

export type InfraLease = {
  readonly env: Env
  readonly server: InfraServer
}

const instanceOf = (spec: InfraSpec, worktree: Worktree) => (spec.scope === "shared" ? "shared" : worktree.id)

const keyOf = (name: InfraName, instance: string) => `${name}|${instance}`

const parseKey = (key: string) => {
  const [name, instance] = key.split("|") as [InfraName, string]
  return { name, instance }
}

const toInfraError = (name: string) => (error: { readonly message: string }) => new InfraError({ infra: name, message: error.message })

export const toolsFor = (proc: Context.Service.Shape<typeof Proc>, instance: string): InfraTools => ({
  spawn: (spawn) =>
    proc
      .spawn({ owner: ownerOfInfra(instance), service: spawn.name, run: spawn.run, env: spawn.env, cwd: spawn.cwd ?? process.cwd() })
      .pipe(
        Effect.map((spawned) => ({ pid: Pid.make(spawned.pid), exited: spawned.exited, output: spawned.output })),
        Effect.mapError(toInfraError(spawn.name))
      ),
  exec: (exec) =>
    proc
      .exec({ owner: ownerOfInfra(instance), service: exec.name, run: exec.run, env: exec.env, cwd: exec.cwd })
      .pipe(Effect.mapError(toInfraError(exec.name)))
})

export class InfraManager extends Context.Service<
  InfraManager,
  {
    readonly acquire: (spec: InfraSpec, worktree: Worktree) => Effect.Effect<InfraLease, InfraError, Scope.Scope>
    readonly running: Effect.Effect<ReadonlyArray<string>>
  }
>()("forkyard/InfraManager") {
  static readonly layer = (options: { readonly domain: string; readonly proxyPort: Port }) =>
    Layer.effect(
      InfraManager,
      Effect.gen(function* () {
        const proc = yield* Proc
        const router = yield* Router
        const specs = yield* Ref.make<Readonly<Record<string, InfraSpec>>>({})

        const hostFor = (name: InfraName, route: string, instance: string) =>
          instance === "shared" ? `${route}.${options.domain}` : `${route}.${instance}.${options.domain}`

        const urlFor = (host: string) => `http://${host}${options.proxyPort === 80 ? "" : `:${options.proxyPort}`}`

        const specFor = (name: InfraName) =>
          Ref.get(specs).pipe(
            Effect.flatMap((all) => {
              const spec = all[name]
              return spec ? Effect.succeed(spec) : Effect.fail(new InfraError({ infra: name, message: "unknown infra" }))
            })
          )

        const exposeRoutes = (name: InfraName, instance: string, started: InfraStarted) =>
          Effect.forEach(Object.entries(started.routes), ([route, port]) => router.expose({ host: hostFor(name, route, instance), port }), {
            discard: true
          })

        const urlsOf = (name: InfraName, instance: string, started: InfraStarted) =>
          Object.fromEntries(Object.keys(started.routes).map((route) => [route, urlFor(hostFor(name, route, instance))]))

        const startInstance = Effect.fn("InfraManager.start", { root: true })(
          function* (key: string) {
            const { name, instance } = parseKey(key)
            const spec = yield* specFor(name)
            yield* Effect.annotateCurrentSpan({
              "forkyard.infra": name,
              "forkyard.infra.instance": instance,
              "forkyard.infra.scope": spec.scope
            })

            const started = yield* spec.start(instance, toolsFor(proc, instance))
            yield* exposeRoutes(name, instance, started)
            const lock = yield* Semaphore.make(1)

            return { ...started, instance, urls: urlsOf(name, instance, started), exclusive: lock.withPermit } satisfies InfraServer
          },
          (effect, key) =>
            effect.pipe(
              Effect.tap(() => Effect.logInfo(`infra ${key.replace("|", " for ")} started`)),
              Effect.tap(() => Effect.addFinalizer(() => Effect.logInfo(`infra ${key.replace("|", " for ")} stopped`)))
            )
        )

        const servers = yield* RcMap.make({ lookup: startInstance, idleTimeToLive: "1 second" })

        const acquire = Effect.fn("InfraManager.acquire")(function* (spec: InfraSpec, worktree: Worktree) {
          yield* Effect.annotateCurrentSpan({
            "forkyard.infra": spec.name,
            "forkyard.infra.scope": spec.scope,
            "forkyard.worktree": worktree.id
          })

          const instance = instanceOf(spec, worktree)
          yield* Ref.update(specs, (all) => ({ ...all, [spec.name]: spec }))
          const server = yield* RcMap.get(servers, keyOf(spec.name, instance))
          const env = yield* spec.tenant(server, worktree, toolsFor(proc, instance))

          return { env, server } satisfies InfraLease
        })

        return InfraManager.of({ acquire, running: RcMap.keys(servers).pipe(Effect.map((keys) => [...keys])) })
      })
    )
}
