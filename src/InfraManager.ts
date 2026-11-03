import { Context, Duration, Effect, Layer, RcMap, Ref, Semaphore, type Scope } from "effect"
import { type InfraName, ownerOfInfra, Pid } from "./Ids.ts"
import { ProxyAddress } from "./ProxyAddress.ts"
import { Proc } from "./Proc.ts"
import { Router } from "./Router.ts"
import { Tenants } from "./Tenants.ts"
import { type Env, InfraError, type InfraServer, type InfraSpec, type InfraStarted, type InfraTools, type Worktree } from "./Stack.ts"

export type InfraLease = {
  readonly env: Env
  readonly server: InfraServer
}

const instanceOf = (spec: InfraSpec, worktree: Worktree) => {
  if (spec.scope === "worktree") return worktree.id
  if (spec.sharedBy === "project") return worktree.project
  return spec.variant ? `shared-${spec.variant}` : "shared"
}

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
        Effect.mapBoth({
          onSuccess: (spawned) => ({ pid: Pid.make(spawned.pid), exited: spawned.exited, output: spawned.output }),
          onFailure: toInfraError(spawn.name)
        })
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
    readonly act: (spec: InfraSpec, server: InfraServer, worktree: Worktree, action: string) => Effect.Effect<string, InfraError>
  }
>()("forkyard/InfraManager") {
  static readonly layer = (options: { readonly domain: string }) =>
    Layer.effect(
      InfraManager,
      Effect.gen(function* () {
        const proxy = yield* ProxyAddress
        const proc = yield* Proc
        const router = yield* Router
        const tenants = yield* Tenants
        const requests = yield* Ref.make<Readonly<Record<string, { readonly spec: InfraSpec; readonly origin: Worktree }>>>({})

        const hostFor = (name: InfraName, route: string, instance: string) =>
          instance === "shared" ? `${route}.${options.domain}` : `${route}.${instance}.${options.domain}`

        const exposeRoutes = (name: InfraName, instance: string, started: InfraStarted) =>
          Effect.forEach(Object.entries(started.routes), ([route, port]) => router.expose({ host: hostFor(name, route, instance), port }), {
            discard: true
          })

        const urlsOf = (name: InfraName, instance: string, started: InfraStarted) =>
          Object.fromEntries(Object.keys(started.routes).map((route) => [route, proxy.url(hostFor(name, route, instance))]))

        const startInstance = Effect.fn("InfraManager.start", { root: true })(
          function* (key: string) {
            const { name, instance } = parseKey(key)
            const request = (yield* Ref.get(requests))[key]
            if (!request) return yield* new InfraError({ infra: name, message: "no worktree asked for this infra" })
            const { spec, origin } = request
            yield* Effect.annotateCurrentSpan({
              "forkyard.infra": name,
              "forkyard.infra.instance": instance,
              "forkyard.infra.scope": spec.scope
            })

            const leases = yield* Effect.forEach(spec.uses ?? [], (dependency) => acquire(dependency, origin), { concurrency: "unbounded" })
            const usesEnv = leases.reduce<Env>((all, lease) => ({ ...all, ...lease.env }), {})

            const started = yield* spec.start(instance, toolsFor(proc, instance), origin, usesEnv)
            yield* exposeRoutes(name, instance, started)
            const lock = yield* Semaphore.make(1)

            return {
              ...started,
              instance,
              urls: urlsOf(name, instance, started),
              exclusive: Semaphore.withPermit(lock)
            } satisfies InfraServer
          },
          (effect, key) =>
            effect.pipe(
              Effect.tap(() => Effect.logInfo(`infra ${key.replace("|", " for ")} started`)),
              Effect.tap(() => Effect.addFinalizer(() => Effect.logInfo(`infra ${key.replace("|", " for ")} stopped`)))
            )
        )

        const servers = yield* RcMap.make({ lookup: startInstance, idleTimeToLive: "1 second" })
        const stopAllAtOnce = RcMap.keys(servers).pipe(
          Effect.flatMap((keys) =>
            Effect.forEach(keys, (key) => RcMap.invalidate(servers, key), { concurrency: "unbounded", discard: true })
          )
        )
        yield* Effect.addFinalizer(() => stopAllAtOnce)

        const forgetTenant = (spec: InfraSpec, server: InfraServer, instance: string, tenant: Worktree) => {
          if (!spec.reap) return Effect.succeed(false)
          return spec.reap
            .forget(server, tenant, toolsFor(proc, instance))
            .pipe(Effect.tap((dropped) => (dropped ? tenants.forget(spec.name, instance, tenant.id) : Effect.void)))
        }

        const reap = Effect.fn("InfraManager.reap")(function* (spec: InfraSpec, server: InfraServer, instance: string) {
          if (!spec.reap) return []
          const graceMillis = Duration.toMillis(spec.reap.after)
          const dropped = yield* server.exclusive(
            tenants
              .unused(spec.name, instance, graceMillis)
              .pipe(Effect.flatMap((unused) => Effect.filter(unused, (tenant) => forgetTenant(spec, server, instance, tenant))))
          )
          if (dropped.length > 0)
            yield* Effect.logInfo(
              `infra ${spec.name}: dropped tenants unused for ${Duration.format(Duration.millis(graceMillis))}: ${dropped.map((tenant) => tenant.id).join(", ")}`
            )
          return dropped
        })

        const acquire: (spec: InfraSpec, worktree: Worktree) => Effect.Effect<InfraLease, InfraError, Scope.Scope> = Effect.fn(
          "InfraManager.acquire"
        )(function* (spec: InfraSpec, worktree: Worktree) {
          yield* Effect.annotateCurrentSpan({
            "forkyard.infra": spec.name,
            "forkyard.infra.scope": spec.scope,
            "forkyard.worktree": worktree.id
          })

          const instance = instanceOf(spec, worktree)
          const key = keyOf(spec.name, instance)
          yield* Ref.update(requests, (all) => ({ ...all, [key]: { spec, origin: worktree } }))
          const server = yield* RcMap.get(servers, key)
          yield* tenants.use(spec.name, instance, worktree)
          const env = yield* spec.tenant(server, worktree, toolsFor(proc, instance))
          yield* reap(spec, server, instance).pipe(
            Effect.catchCause((cause) => Effect.logWarning(`infra ${spec.name}: could not reap unused tenants`, cause)),
            Effect.forkScoped
          )

          return { env, server } satisfies InfraLease
        })

        const act = Effect.fn("InfraManager.act")(function* (spec: InfraSpec, server: InfraServer, worktree: Worktree, action: string) {
          yield* Effect.annotateCurrentSpan({
            "forkyard.infra": spec.name,
            "forkyard.infra.action": action,
            "forkyard.worktree": worktree.id
          })
          const run = spec.actions?.[action]
          if (!run) {
            const known = Object.keys(spec.actions ?? {}).join(", ") || "none"
            return yield* new InfraError({ infra: spec.name, message: `no action "${action}" (available: ${known})` })
          }
          return yield* run(server, worktree, toolsFor(proc, server.instance)).pipe(Effect.scoped)
        })

        return InfraManager.of({ acquire, running: RcMap.keys(servers).pipe(Effect.map((keys) => [...keys])), act })
      })
    )
}
