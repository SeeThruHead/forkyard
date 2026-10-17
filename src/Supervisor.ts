import { Cause, Clock, Context, Deferred, Effect, Layer, Metric, PubSub, Schedule, Schema, Semaphore, type Scope } from "effect"
import { HttpClient } from "effect/http"
import { daemonEnv, EnvResolver, owned, type OwnedEnv } from "./Env.ts"
import type { InfraName, Port, ServiceName, WorktreeId } from "./Ids.ts"
import { ownerOfWorktree } from "./Ids.ts"
import { InfraManager } from "./InfraManager.ts"
import * as Metrics from "./Metrics.ts"
import type { RunRef, ServiceState, ServiceView } from "./Model.ts"
import { plan } from "./Plan.ts"
import { allocatePort } from "./Ports.ts"
import { Proc, type Spawned } from "./Proc.ts"
import { Router } from "./Router.ts"
import { hostOf, type InfraNode, type InfraSpec, type Node, type ServiceNode, type Stack, urlOf, type Worktree } from "./Stack.ts"
import { Status } from "./Status.ts"

export class TaskFailed extends Schema.TaggedError<TaskFailed>()("TaskFailed", {
  service: Schema.String,
  exitCode: Schema.Number
}) {}

export class DependencyFailed extends Schema.TaggedError<DependencyFailed>()("DependencyFailed", {
  service: Schema.String
}) {}

type Readiness = Readonly<Record<string, Deferred.Deferred<void, DependencyFailed>>>

type InfraEnv = Readonly<Record<InfraName, OwnedEnv>>

const isService = (node: Node): node is ServiceNode => node._tag === "Service"

const isInfra = (node: Node): node is InfraNode => node._tag === "Infra"

const restartKey = (id: WorktreeId, service: ServiceName) => `${id}/${service}`

const worktreeAttributes = (worktree: Worktree) => ({
  "forkyard.worktree": worktree.id,
  "forkyard.project": worktree.project,
  "forkyard.branch": worktree.branch
})

const serviceAttributes = (worktree: Worktree, service: ServiceNode) => ({
  ...worktreeAttributes(worktree),
  "forkyard.service": service.name,
  "forkyard.kind": service.kind
})

const viewOf = (worktree: Worktree, service: ServiceNode, state: ServiceState): ServiceView => {
  if (service.kind === "http") return { _tag: "Http", url: urlOf(worktree, service.name), state }
  if (service.kind === "worker") return { _tag: "Worker", state }
  return { _tag: "Task", state }
}

const ownedEnvFor = (service: ServiceNode, infraEnv: InfraEnv): OwnedEnv => ({
  ...service.uses.reduce<OwnedEnv>((all, name) => ({ ...all, ...infraEnv[name] }), {}),
  ...owned("forkyard.config", service.env)
})

const reasonOf = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split("\n")[0]?.slice(0, 300) ?? "failed"

export class Supervisor extends Context.Service<
  Supervisor,
  {
    readonly run: (stack: Stack, worktree: Worktree) => Effect.Effect<never, unknown, Scope.Scope>
    readonly restart: (id: WorktreeId, service: ServiceName) => Effect.Effect<void>
  }
>()("forkyard/Supervisor") {
  static readonly layer = (options: { readonly startupConcurrency: number; readonly otlpUrl: string }) =>
    Layer.effect(
      Supervisor,
      Effect.gen(function* () {
        const infra = yield* InfraManager
        const proc = yield* Proc
        const router = yield* Router
        const status = yield* Status
        const env = yield* EnvResolver
        const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
        const startup = yield* Semaphore.make(options.startupConcurrency)
        const restarts = yield* PubSub.unbounded<string>()

        const setState = (worktree: Worktree, service: ServiceNode, state: ServiceState) =>
          status.serviceState(worktree.id, service.name, state)

        const waitHealthy = (port: Port, path: string) =>
          http
            .get(`http://127.0.0.1:${port}${path}`)
            .pipe(
              Effect.retry(Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: "60 seconds" }))),
              Effect.asVoid,
              Effect.withSpan("Supervisor.waitHealthy", { attributes: { "server.port": port, "url.path": path } })
            )

        const restartRequested = Effect.fnUntraced(function* (worktree: Worktree, service: ServiceNode) {
          const subscription = yield* PubSub.subscribe(restarts)
          const key = restartKey(worktree.id, service.name)

          return PubSub.take(subscription).pipe(Effect.repeat({ until: (requested) => requested === key }), Effect.as("restart requested"))
        })

        const recordReady = (worktree: Worktree, service: ServiceNode, since: number) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Metric.update(
                Metric.withAttributes(Metrics.serviceReady, { "forkyard.service": service.name, "forkyard.project": worktree.project }),
                now - since
              )
            )
          )

        const recordRestart = (service: ServiceNode, reason: string) =>
          Metric.update(
            Metric.withAttributes(Metrics.restarts, {
              "forkyard.service": service.name,
              "forkyard.reason": reason.startsWith("restart") ? "requested" : "exited"
            }),
            1
          )

        const acquireInfra = Effect.fn("Supervisor.acquireInfra")(
          function* (worktree: Worktree, spec: InfraSpec) {
            yield* Effect.annotateCurrentSpan({
              ...worktreeAttributes(worktree),
              "forkyard.infra": spec.name,
              "forkyard.infra.scope": spec.scope
            })
            yield* status.infra(worktree.id, spec.name, { _tag: "InfraStarting", scope: spec.scope })

            const began = yield* Clock.currentTimeMillis
            const lease = yield* infra.acquire(spec, worktree)
            const url = Object.values(lease.server.urls)[0]

            yield* status.infra(worktree.id, spec.name, {
              _tag: "InfraReady",
              scope: spec.scope,
              instance: lease.server.instance,
              ...(url ? { url } : {})
            })
            yield* Metric.update(
              Metric.withAttributes(Metrics.infraStart, { "forkyard.infra": spec.name }),
              (yield* Clock.currentTimeMillis) - began
            )

            return [spec.name, owned(`infra:${spec.name}`, lease.env)] as const
          },
          (effect, worktree, spec) =>
            effect.pipe(
              Effect.tapError((error) =>
                status.infra(worktree.id, spec.name, { _tag: "InfraFailed", scope: spec.scope, reason: String(error) })
              )
            )
        )

        const prepare = Effect.fn("Supervisor.prepare")(function* (stack: Stack, worktree: Worktree) {
          yield* Effect.annotateCurrentSpan(worktreeAttributes(worktree))

          const nodes = yield* stack.build(worktree)
          yield* plan(nodes)

          const leases = yield* Effect.forEach(nodes.filter(isInfra), (node) => acquireInfra(worktree, node.spec), {
            concurrency: "unbounded"
          })

          return { services: nodes.filter(isService), infraEnv: Object.fromEntries(leases) as InfraEnv }
        })

        const readinessOf = (services: ReadonlyArray<ServiceNode>) =>
          Effect.forEach(services, (service) =>
            Deferred.make<void, DependencyFailed>().pipe(Effect.map((ready) => [service.name, ready] as const))
          ).pipe(Effect.map((entries): Readiness => Object.fromEntries(entries)))

        const awaitDependencies = (service: ServiceNode, readiness: Readiness) =>
          Effect.forEach(service.after, (name) => Deferred.await(readiness[name]!), { discard: true })

        const spawnService = (worktree: Worktree, service: ServiceNode, serviceEnv: Readonly<Record<string, string>>) =>
          proc.spawn({
            owner: ownerOfWorktree(worktree.id),
            service: service.name,
            run: service.run,
            env: serviceEnv,
            cwd: `${worktree.root}/${service.cwd}`,
            telemetry: { namespace: worktree.id, attributes: worktreeAttributes(worktree) }
          })

        const serveByName = Effect.fnUntraced(function* (worktree: Worktree, service: ServiceNode, port: Port, spawned: Spawned) {
          yield* router.expose({ host: hostOf(worktree, service.name), port })
          yield* waitHealthy(port, service.health).pipe(Effect.raceFirst(spawned.exited))
        })

        const startService = Effect.fn("Supervisor.startService", { root: true })(function* (
          worktree: Worktree,
          service: ServiceNode,
          ownedEnv: OwnedEnv
        ) {
          yield* Effect.annotateCurrentSpan(serviceAttributes(worktree, service))
          yield* setState(worktree, service, { _tag: "Preparing" })

          const port = service.kind === "http" ? yield* allocatePort : undefined
          const serviceEnv = yield* env.resolve(worktree, service, {
            ...ownedEnv,
            ...daemonEnv(worktree, service.name, port, options.otlpUrl)
          })
          const spawned = yield* spawnService(worktree, service, serviceEnv)

          yield* Effect.annotateCurrentSpan({ "forkyard.run": spawned.run.run, "process.pid": spawned.pid })
          yield* setState(worktree, service, { _tag: "Starting", run: spawned.run })
          if (port) yield* serveByName(worktree, service, port, spawned)

          return spawned
        })

        const markReady = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          run: RunRef,
          ready: Deferred.Deferred<void, DependencyFailed>,
          since: number
        ) {
          yield* setState(worktree, service, { _tag: "Ready", run })
          yield* Deferred.succeed(ready, undefined)
          yield* recordReady(worktree, service, since)
        })

        const markRestarting = Effect.fnUntraced(
          function* (worktree: Worktree, service: ServiceNode, run: RunRef, reason: string) {
            yield* setState(worktree, service, { _tag: "Restarting", run, reason })
            yield* recordRestart(service, reason)
          },
          (effect, worktree, service, _run, reason) =>
            effect.pipe(Effect.tap(() => Effect.logWarning(`${worktree.id}/${service.name} ${reason}, restarting`)))
        )

        const exitReason = (spawned: Spawned) => spawned.exited.pipe(Effect.map((code) => `exited with ${code}`))

        const serviceRun = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          ownedEnv: OwnedEnv,
          ready: Deferred.Deferred<void, DependencyFailed>
        ) {
          const restartWanted = yield* restartRequested(worktree, service)
          const began = yield* Clock.currentTimeMillis
          const spawned = yield* startup.withPermit(startService(worktree, service, ownedEnv))

          yield* markReady(worktree, service, spawned.run, ready, began)

          const reason = yield* Effect.raceFirst(exitReason(spawned), restartWanted)
          yield* markRestarting(worktree, service, spawned.run, reason)
        }, Effect.scoped)

        const keepRunning = (
          worktree: Worktree,
          service: ServiceNode,
          ownedEnv: OwnedEnv,
          ready: Deferred.Deferred<void, DependencyFailed>
        ) =>
          serviceRun(worktree, service, ownedEnv, ready).pipe(
            Effect.catchCause((cause) => setState(worktree, service, { _tag: "Failed", reason: reasonOf(cause) })),
            Effect.repeat(Schedule.spaced("1 second")),
            Effect.andThen(Effect.never)
          )

        const runToExit = Effect.fnUntraced(function* (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv) {
          const serviceEnv = yield* env.resolve(worktree, service, {
            ...ownedEnv,
            ...daemonEnv(worktree, service.name, undefined, options.otlpUrl)
          })
          const spawned = yield* spawnService(worktree, service, serviceEnv)

          yield* setState(worktree, service, { _tag: "Starting", run: spawned.run })

          return { run: spawned.run, code: yield* spawned.exited }
        }, Effect.scoped)

        const runTask = Effect.fn("Supervisor.runTask", { root: true })(
          function* (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv, ready: Deferred.Deferred<void, DependencyFailed>) {
            yield* Effect.annotateCurrentSpan(serviceAttributes(worktree, service))
            yield* setState(worktree, service, { _tag: "Preparing" })

            const { run, code } = yield* startup.withPermit(runToExit(worktree, service, ownedEnv))
            yield* Effect.annotateCurrentSpan({ "process.exit_code": code })
            if (code !== 0) return yield* new TaskFailed({ service: service.name, exitCode: code })

            yield* setState(worktree, service, { _tag: "Done", run })
            yield* Deferred.succeed(ready, undefined)
          },
          (effect, worktree, service, _ownedEnv, ready) =>
            effect.pipe(
              Effect.tapCause((cause) =>
                Effect.all(
                  [
                    setState(worktree, service, { _tag: "Failed", reason: reasonOf(cause) }),
                    Deferred.fail(ready, new DependencyFailed({ service: service.name }))
                  ],
                  { discard: true }
                )
              )
            )
        )

        const supervise = Effect.fnUntraced(
          function* (worktree: Worktree, service: ServiceNode, infraEnv: InfraEnv, readiness: Readiness) {
            const ready = readiness[service.name]!
            yield* status.service(worktree.id, service.name, viewOf(worktree, service, { _tag: "Waiting" }))
            yield* awaitDependencies(service, readiness)

            const ownedEnv = ownedEnvFor(service, infraEnv)
            if (service.kind === "task") return yield* runTask(worktree, service, ownedEnv, ready)
            return yield* keepRunning(worktree, service, ownedEnv, ready)
          },
          (effect, worktree, service, _infraEnv, readiness) =>
            effect.pipe(
              Effect.catchTag("DependencyFailed", (failed) =>
                Effect.all(
                  [
                    setState(worktree, service, { _tag: "Failed", reason: `${failed.service} failed` }),
                    Deferred.fail(readiness[service.name]!, new DependencyFailed({ service: service.name }))
                  ],
                  { discard: true }
                )
              )
            )
        )

        const run = Effect.fnUntraced(function* (stack: Stack, worktree: Worktree): Effect.fn.Return<never, unknown, Scope.Scope> {
          const { services, infraEnv } = yield* prepare(stack, worktree)
          const readiness = yield* readinessOf(services)

          yield* Effect.addFinalizer(() => env.forget(worktree.id))
          yield* Effect.forEach(services, (service) => Effect.forkScoped(supervise(worktree, service, infraEnv, readiness)), {
            discard: true
          })

          return yield* Effect.never
        })

        return Supervisor.of({
          run,
          restart: (id, service) => PubSub.publish(restarts, restartKey(id, service)).pipe(Effect.asVoid)
        })
      })
    )
}
