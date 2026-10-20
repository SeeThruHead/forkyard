import {
  Cause,
  Clock,
  Config,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Metric,
  Option,
  Path,
  PubSub,
  Queue,
  RcMap,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Scope,
  Stream,
  SubscriptionRef
} from "effect"
import { HttpClient } from "effect/http"
import { Activity } from "./Activity.ts"
import { Changes, type Session } from "./Changes.ts"
import { daemonEnv, EnvResolver, owned, type OwnedEnv, telemetryDefaults } from "./Env.ts"
import { BranchSlug, type InfraName, ownerOfWorktree, type Port, type ServiceName, type WorktreeId, worktreeId } from "./Ids.ts"
import { InfraManager } from "./InfraManager.ts"
import type { InputsTarget } from "./Inputs.ts"
import { instanceKey, Instances } from "./Instances.ts"
import * as Metrics from "./Metrics.ts"
import type { RunRef, ServiceState, ServiceView } from "./Model.ts"
import { Pins } from "./Pins.ts"
import { demandedNames, localNames } from "./Placement.ts"
import { plan } from "./Plan.ts"
import { allocatePort } from "./Ports.ts"
import { Proc, type Spawned } from "./Proc.ts"
import { pollUntilReady, unlessItExits } from "./Readiness.ts"
import { Router } from "./Router.ts"
import {
  defaultProfile,
  hostOf,
  InfraError,
  type InfraNode,
  type InfraServer,
  type InfraSpec,
  type Node,
  type OnExit,
  type Run,
  type ServiceNode,
  type Stack,
  urlOf,
  type Watch,
  type Worktree
} from "./Stack.ts"
import { Status } from "./Status.ts"
import { Waker } from "./Waker.ts"
import { changesUnder } from "./Watch.ts"

export class DependencyFailed extends Schema.TaggedError<DependencyFailed>()("DependencyFailed", {
  service: Schema.String
}) {}

type Ready = Deferred.Deferred<void, DependencyFailed>

type Readiness = Readonly<Record<string, Ready>>

type ServiceEnv = Effect.Effect<OwnedEnv, InfraError, Scope.Scope>

type Outcome =
  | { readonly _tag: "Exited"; readonly code: number }
  | { readonly _tag: "RestartRequested" }
  | { readonly _tag: "FilesChanged" }

type Finished = { readonly run: RunRef; readonly code: number }

type Placement = "asleep" | "local" | "shared"

type SharedRun = { readonly worktree: Worktree; readonly base: SubscriptionRef.SubscriptionRef<string> }

type Running = { readonly stack: Stack; readonly worktree: Worktree }

const isService = (node: Node): node is ServiceNode => node._tag === "Service"

const isInfra = (node: Node): node is InfraNode => node._tag === "Infra"

const isLongRunning = (service: ServiceNode) => service.lifecycle._tag === "LongRunning"

const restartKey = (id: WorktreeId, service: ServiceName) => `${id}/${service}`

const worktreeAttributes = (worktree: Worktree) => ({
  "forkyard.worktree": worktree.id,
  "forkyard.project": worktree.project,
  "forkyard.branch": worktree.branch
})

const serviceAttributes = (worktree: Worktree, service: ServiceNode) => ({
  ...worktreeAttributes(worktree),
  "forkyard.service": service.name,
  "forkyard.lifecycle": service.lifecycle._tag,
  "forkyard.exposure": service.exposure._tag
})

const viewOf = (worktree: Worktree, service: ServiceNode, state: ServiceState): ServiceView => {
  if (service.exposure._tag === "Routed") return { _tag: "Http", url: urlOf(worktree, service.name), state }
  if (service.lifecycle._tag === "RunOnce") return { _tag: "Task", state }
  return { _tag: "Worker", state }
}

const reasonOf = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split("\n")[0]?.slice(0, 300) ?? "failed"

const describe = (outcome: Outcome) => {
  if (outcome._tag === "Exited") return `exited with ${outcome.code}`
  if (outcome._tag === "FilesChanged") return "files changed"
  return "restart requested"
}

const shouldRestart = (onExit: OnExit, outcome: Outcome) => {
  if (outcome._tag !== "Exited") return true
  if (onExit === "restart") return true
  if (onExit === "restart-on-failure") return outcome.code !== 0
  return false
}

const endState = (run: RunRef, outcome: Outcome, restarting: boolean): ServiceState => {
  if (restarting) return { _tag: "Restarting", run, reason: describe(outcome) }
  if (outcome._tag === "Exited" && outcome.code === 0) return { _tag: "Done", run }
  return { _tag: "Failed", reason: describe(outcome), run }
}

const restartDelay = (failures: number) => Duration.seconds(failures === 0 ? 1 : Math.min(30, 2 ** failures))

type Attempt = { readonly again: boolean; readonly failures: number }

const readyLineOf = (service: ServiceNode) =>
  service.lifecycle._tag === "LongRunning" && service.lifecycle.ready._tag === "LogLine"
    ? { readyLine: service.lifecycle.ready.pattern }
    : {}

const git = (...args: ReadonlyArray<string>): Run => ({ command: "git", args })

const sharedBranch = (profile: string) => BranchSlug.make(profile === defaultProfile ? "shared" : `shared-${profile}`)

const sharedKeyOf = (worktree: Worktree) => `${worktree.project}|${worktree.profile}`

const sameNames = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((name) => b.has(name))

const targetsOf = (services: ReadonlyArray<ServiceNode>, infra: ReadonlyArray<InfraNode>): ReadonlyArray<InputsTarget> => [
  ...services.map((service) => ({ name: service.name, kind: "service" as const })),
  ...infra.map((node) => ({ name: node.spec.name, kind: "infra" as const }))
]

const rootsOf = (services: ReadonlyArray<ServiceNode>, own: ReadonlySet<string>, started: ReadonlySet<string>) =>
  new Set([...services.filter((service) => isLongRunning(service) && own.has(service.name)).map((service) => service.name), ...started])

export class Supervisor extends Context.Service<
  Supervisor,
  {
    readonly run: (stack: Stack, worktree: Worktree) => Effect.Effect<never, unknown, Scope.Scope>
    readonly restart: (id: WorktreeId, service: ServiceName) => Effect.Effect<void>
    readonly own: (id: WorktreeId, service: ServiceName) => Effect.Effect<void>
    readonly share: (id: WorktreeId, service: ServiceName) => Effect.Effect<void>
    readonly start: (id: WorktreeId, service: ServiceName) => Effect.Effect<void>
    readonly stop: (id: WorktreeId, service: ServiceName) => Effect.Effect<void>
    readonly updateShared: (id: WorktreeId) => Effect.Effect<string, InfraError>
    readonly infraAction: (id: WorktreeId, infra: InfraName, action: string) => Effect.Effect<string, InfraError>
  }
>()("forkyard/Supervisor") {
  static readonly layer = (options: {
    readonly startupConcurrency: number
    readonly otlpUrl: string | undefined
    readonly otlpHeaders: string
    readonly sharedDir: string
  }) =>
    Layer.effect(
      Supervisor,
      Effect.gen(function* () {
        const infra = yield* InfraManager
        const instances = yield* Instances
        const pins = yield* Pins
        const changes = yield* Changes
        const proc = yield* Proc
        const router = yield* Router
        const waker = yield* Waker
        const activity = yield* Activity
        const status = yield* Status
        const env = yield* EnvResolver
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const basePath = yield* Config.String("PATH").pipe(Config.withDefault(""))
        const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
        const startup = yield* Semaphore.make(options.startupConcurrency)
        const restarts = yield* PubSub.unbounded<string>()
        const running = yield* Ref.make<Readonly<Record<string, Running>>>({})
        const sharedDemand = yield* SubscriptionRef.make<Readonly<Record<string, number>>>({})
        const sharedRequests = yield* Ref.make<Readonly<Record<string, Running>>>({})
        const held = yield* Ref.make<
          Readonly<Record<string, { readonly spec: InfraSpec; readonly server: InfraServer; readonly worktree: Worktree }>>
        >({})
        const heldKey = (id: WorktreeId, name: InfraName) => `${id}|${name}`

        const hold = (worktree: Worktree, spec: InfraSpec, server: InfraServer) => {
          const key = heldKey(worktree.id, spec.name)
          return Ref.update(held, (all) => ({ ...all, [key]: { spec, server, worktree } })).pipe(
            Effect.andThen(
              Effect.addFinalizer(() =>
                Ref.update(held, (all) => Object.fromEntries(Object.entries(all).filter(([entry]) => entry !== key)))
              )
            )
          )
        }

        const infraAction = Effect.fn("Supervisor.infraAction")(function* (id: WorktreeId, name: InfraName, action: string) {
          const entry = (yield* Ref.get(held))[heldKey(id, name)]
          if (!entry) return yield* new InfraError({ infra: name, message: `${id} is not running ${name}` })
          return yield* infra.act(entry.spec, entry.server, entry.worktree, action)
        })

        const withStartSlot = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.acquireUseRelease(
            Semaphore.take(startup, 1).pipe(Effect.withSpan("Supervisor.awaitStartSlot")),
            () => effect,
            () => Semaphore.release(startup, 1)
          )

        const setState = (worktree: Worktree, service: ServiceNode, state: ServiceState) =>
          status.serviceState(worktree.id, service.name, state)

        const waitHealthy = (port: Port, path: string) =>
          pollUntilReady(path, http.get(`http://127.0.0.1:${port}${path}`), { every: "100 millis", within: "60 seconds" }).pipe(
            Effect.asVoid,
            Effect.withSpan("Supervisor.waitHealthy", { attributes: { "server.port": port, "url.path": path } })
          )

        const waitRouted = (base: string, path: string) =>
          pollUntilReady(base, http.get(`${base}${path}`), { every: "100 millis", within: "10 seconds" }).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.logWarning(`${base} is healthy but not reachable through the proxy yet`)),
            Effect.withSpan("Supervisor.waitRouted", { attributes: { "url.full": `${base}${path}` } })
          )

        const restartRequested = Effect.fnUntraced(function* (worktree: Worktree, service: ServiceNode) {
          const subscription = yield* PubSub.subscribe(restarts)
          const key = restartKey(worktree.id, service.name)

          return PubSub.take(subscription).pipe(
            Effect.repeat({ until: (requested) => requested === key }),
            Effect.as<Outcome>({ _tag: "RestartRequested" })
          )
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

        const recordEnd = (service: ServiceNode, outcome: Outcome) =>
          Metric.update(
            Metric.withAttributes(Metrics.restarts, {
              "forkyard.service": service.name,
              "forkyard.reason": describe(outcome)
            }),
            1
          )

        const acquireInfra = Effect.fn("Supervisor.acquireInfra")(
          function* (worktree: Worktree, spec: InfraSpec, tenant: Worktree) {
            yield* Effect.annotateCurrentSpan({
              ...worktreeAttributes(worktree),
              "forkyard.infra": spec.name,
              "forkyard.infra.scope": spec.scope,
              "forkyard.infra.tenant": tenant.id
            })
            yield* status.infra(worktree.id, spec.name, { _tag: "InfraStarting", scope: spec.scope })

            const began = yield* Clock.currentTimeMillis
            const lease = yield* infra.acquire(spec, tenant)
            yield* hold(worktree, spec, lease.server)
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

            return owned(`infra:${spec.name}`, lease.env)
          },
          (effect, worktree, spec) =>
            effect.pipe(
              Effect.tapError((error) =>
                status.infra(worktree.id, spec.name, { _tag: "InfraFailed", scope: spec.scope, reason: String(error) })
              )
            )
        )

        const readinessOf = (services: ReadonlyArray<ServiceNode>) =>
          Effect.forEach(services, (service) =>
            Deferred.make<void, DependencyFailed>().pipe(Effect.map((ready) => [service.name, ready] as const))
          ).pipe(Effect.map((entries): Readiness => Object.fromEntries(entries)))

        const awaitDependencies = (service: ServiceNode, readiness: Readiness) =>
          Effect.forEach(service.after, (name) => Deferred.await(readiness[name]!), { discard: true })

        const spawnProcess = (worktree: Worktree, service: ServiceNode, serviceEnv: Readonly<Record<string, string>>) =>
          proc.spawn({
            owner: ownerOfWorktree(worktree.id),
            service: service.name,
            run: service.run,
            env: serviceEnv,
            cwd: `${worktree.root}/${service.cwd}`,
            ...readyLineOf(service),
            ...(service.stopTimeout ? { stopTimeout: service.stopTimeout } : {}),
            telemetry: { namespace: worktree.id, attributes: worktreeAttributes(worktree) }
          })

        const daemonContext = { otlpUrl: options.otlpUrl, otlpHeaders: options.otlpHeaders, basePath }

        const resolveEnv = (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv, port: Port | undefined) =>
          env.resolve(worktree, service, {
            ...telemetryDefaults(worktree, service, daemonContext),
            ...ownedEnv,
            ...daemonEnv(worktree, service, port, daemonContext)
          })

        const allocateNamedPorts = (service: ServiceNode) =>
          Effect.forEach(service.ports, (key) => allocatePort.pipe(Effect.map((port) => [key, String(port)] as const))).pipe(
            Effect.map((entries): OwnedEnv => owned("forkyard:ports", Object.fromEntries(entries)))
          )

        const readyCheck = (service: ServiceNode, spawned: Spawned, port: Port | undefined) => {
          if (service.lifecycle._tag === "RunOnce") return Effect.void
          if (service.lifecycle.ready._tag === "LogLine") return spawned.logged
          if (service.lifecycle.ready._tag === "Started") return Effect.void
          if (!port || service.exposure._tag !== "Routed") return Effect.void
          return waitHealthy(port, service.exposure.health)
        }

        const awaitReadiness = (service: ServiceNode, spawned: Spawned, port: Port | undefined) =>
          readyCheck(service, spawned, port).pipe(unlessItExits(spawned), Effect.asVoid)

        const startProcess = Effect.fn("Supervisor.startService", { root: true })(function* (
          worktree: Worktree,
          service: ServiceNode,
          serviceEnv: ServiceEnv
        ) {
          yield* Effect.annotateCurrentSpan(serviceAttributes(worktree, service))
          yield* setState(worktree, service, { _tag: "Preparing" })

          const port = service.exposure._tag === "Routed" ? yield* allocatePort : undefined
          const extraPorts = yield* allocateNamedPorts(service)
          const spawned = yield* spawnProcess(
            worktree,
            service,
            yield* resolveEnv(worktree, service, { ...(yield* serviceEnv), ...extraPorts }, port)
          )
          yield* Effect.annotateCurrentSpan({ "forkyard.run": spawned.run.run, "process.pid": spawned.pid })
          yield* setState(worktree, service, { _tag: "Starting", run: spawned.run })

          if (port) yield* router.expose({ host: hostOf(worktree, service.name), port })
          yield* awaitReadiness(service, spawned, port)
          if (port && service.exposure._tag === "Routed") yield* waitRouted(urlOf(worktree, service.name), service.exposure.health)
          if (port) yield* instances.publish(instanceKey(worktree.id, service.name), port)

          return spawned
        })

        const markReady = Effect.fnUntraced(function* (worktree: Worktree, service: ServiceNode, run: RunRef, ready: Ready, since: number) {
          yield* setState(worktree, service, { _tag: "Ready", run })
          yield* Deferred.succeed(ready, undefined)
          yield* recordReady(worktree, service, since)
        })

        const markEnded = Effect.fnUntraced(
          function* (worktree: Worktree, service: ServiceNode, run: RunRef, outcome: Outcome, restarting: boolean) {
            yield* setState(worktree, service, endState(run, outcome, restarting))
            yield* recordEnd(service, outcome)
          },
          (effect, worktree, service, _run, outcome, restarting) =>
            effect.pipe(
              Effect.tap(() => Effect.logWarning(`${worktree.id}/${service.name} ${describe(outcome)}${restarting ? ", restarting" : ""}`))
            )
        )

        const exitOutcome = (spawned: Spawned) => spawned.exited.pipe(Effect.map((code): Outcome => ({ _tag: "Exited", code })))

        const watching = (worktree: Worktree, watch: Watch | undefined) =>
          watch
            ? changesUnder(worktree.root, watch).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path)
              )
            : Effect.succeed(Effect.never)

        const runLongRunning = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          onExit: OnExit,
          serviceEnv: ServiceEnv,
          ready: Ready,
          nextChange: Effect.Effect<void>
        ) {
          const restartWanted = yield* restartRequested(worktree, service)
          const began = yield* Clock.currentTimeMillis
          const spawned = yield* withStartSlot(startProcess(worktree, service, serviceEnv))

          yield* markReady(worktree, service, spawned.run, ready, began)

          const changed = nextChange.pipe(Effect.as<Outcome>({ _tag: "FilesChanged" }))
          const outcome = yield* Effect.raceAll([exitOutcome(spawned), restartWanted, changed])
          const restarting = shouldRestart(onExit, outcome)
          yield* markEnded(worktree, service, spawned.run, outcome, restarting)

          return { again: restarting, crashed: outcome._tag === "Exited" && outcome.code !== 0 }
        }, Effect.scoped)

        const keepRunning = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          lifecycle: { readonly onExit: OnExit; readonly watch: Watch | undefined },
          serviceEnv: ServiceEnv,
          ready: Ready,
          moved: Effect.Effect<void>
        ) {
          const nextChange = Effect.raceFirst(yield* watching(worktree, lifecycle.watch), moved)
          const failed = (cause: Cause.Cause<unknown>) => setState(worktree, service, { _tag: "Failed", reason: reasonOf(cause) })

          const attempt = (failures: number): Effect.Effect<void> =>
            runLongRunning(worktree, service, lifecycle.onExit, serviceEnv, ready, nextChange).pipe(
              Effect.map(({ again, crashed }): Attempt => ({ again, failures: crashed ? failures + 1 : 0 })),
              Effect.catchCause((cause) => failed(cause).pipe(Effect.as<Attempt>({ again: true, failures: failures + 1 }))),
              Effect.flatMap((next) =>
                next.again ? Effect.sleep(restartDelay(next.failures)).pipe(Effect.andThen(attempt(next.failures))) : Effect.void
              )
            )

          return yield* attempt(0)
        })

        const runToExit = Effect.fnUntraced(function* (worktree: Worktree, service: ServiceNode, serviceEnv: ServiceEnv) {
          const spawned = yield* spawnProcess(worktree, service, yield* resolveEnv(worktree, service, yield* serviceEnv, undefined))
          yield* setState(worktree, service, { _tag: "Starting", run: spawned.run })

          return { run: spawned.run, code: yield* spawned.exited } satisfies Finished
        }, Effect.scoped)

        const runOnce = Effect.fn("Supervisor.runTask", { root: true })(function* (
          worktree: Worktree,
          service: ServiceNode,
          serviceEnv: ServiceEnv
        ) {
          yield* Effect.annotateCurrentSpan(serviceAttributes(worktree, service))
          yield* setState(worktree, service, { _tag: "Preparing" })

          const finished = yield* withStartSlot(runToExit(worktree, service, serviceEnv))
          yield* Effect.annotateCurrentSpan({ "process.exit_code": finished.code })

          return finished
        })

        const recordFinished = (worktree: Worktree, service: ServiceNode, ready: Ready) => (finished: Finished) => {
          if (finished.code === 0) {
            return Effect.all([setState(worktree, service, { _tag: "Done", run: finished.run }), Deferred.succeed(ready, undefined)], {
              discard: true
            })
          }
          return Effect.all(
            [
              setState(worktree, service, { _tag: "Failed", reason: `exited with ${finished.code}`, run: finished.run }),
              Deferred.fail(ready, new DependencyFailed({ service: service.name }))
            ],
            { discard: true }
          )
        }

        const runTaskOnce = (worktree: Worktree, service: ServiceNode, serviceEnv: ServiceEnv, ready: Ready) =>
          runOnce(worktree, service, serviceEnv).pipe(Effect.flatMap(recordFinished(worktree, service, ready)))

        const runTask = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          watch: Watch | undefined,
          serviceEnv: ServiceEnv,
          ready: Ready,
          moved: Effect.Effect<void>
        ) {
          const nextChange = Effect.raceFirst(yield* watching(worktree, watch), moved)

          return yield* runTaskOnce(worktree, service, serviceEnv, ready).pipe(Effect.andThen(nextChange), Effect.forever)
        })

        const failDependents = (worktree: Worktree, service: ServiceNode, readiness: Readiness) => (failed: DependencyFailed) =>
          Effect.all(
            [
              setState(worktree, service, { _tag: "Failed", reason: `${failed.service} failed` }),
              Deferred.fail(readiness[service.name]!, new DependencyFailed({ service: service.name }))
            ],
            { discard: true }
          )

        const supervise = Effect.fnUntraced(
          function* (worktree: Worktree, service: ServiceNode, serviceEnv: ServiceEnv, readiness: Readiness, moved: Effect.Effect<void>) {
            const ready = readiness[service.name]!

            yield* status.service(worktree.id, service.name, viewOf(worktree, service, { _tag: "Waiting" }))
            yield* awaitDependencies(service, readiness)

            if (service.lifecycle._tag === "RunOnce")
              return yield* runTask(worktree, service, service.lifecycle.watch, serviceEnv, ready, moved)
            return yield* keepRunning(worktree, service, service.lifecycle, serviceEnv, ready, moved)
          },
          (effect, worktree, service, _serviceEnv, readiness) =>
            effect.pipe(
              Effect.catchTag("DependencyFailed", failDependents(worktree, service, readiness)),
              Effect.catchCause((cause) => setState(worktree, service, { _tag: "Failed", reason: reasonOf(cause) }))
            )
        )

        const mirror = (worktree: Worktree, service: ServiceNode, ready: Ready) => (state: ServiceState) => {
          const apply = setState(worktree, service, state)
          if (state._tag === "Ready" || state._tag === "Done") return apply.pipe(Effect.andThen(Deferred.succeed(ready, undefined)))
          if (state._tag === "Failed")
            return apply.pipe(Effect.andThen(Deferred.fail(ready, new DependencyFailed({ service: service.name }))))
          return apply
        }

        const signalOnChange = Effect.fnUntraced(function* <A>(values: Stream.Stream<A>) {
          const signals = yield* Queue.sliding<void>(1)
          yield* values.pipe(
            Stream.drop(1),
            Stream.runForEach(() => Queue.offer(signals, undefined)),
            Effect.forkScoped
          )
          return Queue.take(signals).pipe(Effect.asVoid)
        })

        const demandShared = (sharedId: WorktreeId, service: ServiceName) => {
          const key = restartKey(sharedId, service)
          const adjust = (by: number) => (all: Readonly<Record<string, number>>) => ({ ...all, [key]: (all[key] ?? 0) + by })
          return Effect.acquireRelease(SubscriptionRef.update(sharedDemand, adjust(1)), () =>
            SubscriptionRef.update(sharedDemand, adjust(-1))
          ).pipe(Effect.asVoid)
        }

        const demandedIn = (sharedId: WorktreeId) =>
          SubscriptionRef.changes(sharedDemand).pipe(
            Stream.map(
              (all) =>
                new Set(
                  Object.entries(all)
                    .filter(([key, count]) => count > 0 && key.startsWith(`${sharedId}/`))
                    .map(([key]) => key.slice(sharedId.length + 1))
                )
            ),
            Stream.changesWith(sameNames)
          )

        const routeTo = (worktree: Worktree, service: ServiceNode, port: Port) =>
          Stream.scoped(Stream.fromEffect(router.expose({ host: hostOf(worktree, service.name), port })).pipe(Stream.concat(Stream.never)))

        const followSharedState = (worktree: Worktree, service: ServiceNode, sharedId: WorktreeId, ready: Ready) =>
          status.changes.pipe(
            Stream.map((snapshot) => snapshot[sharedId]?.services[service.name]?.state),
            Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
            Stream.runForEach((state) => (state ? mirror(worktree, service, ready)(state) : Effect.void))
          )

        const followSharedRoute = (worktree: Worktree, service: ServiceNode, sharedId: WorktreeId) => {
          if (service.exposure._tag !== "Routed") return Effect.never
          return instances.watch(instanceKey(sharedId, service.name)).pipe(
            Stream.switchMap((port) => (port ? routeTo(worktree, service, port) : Stream.never)),
            Stream.runDrain
          )
        }

        const useShared = Effect.fnUntraced(function* (worktree: Worktree, service: ServiceNode, shared: SharedRun, readiness: Readiness) {
          yield* status.service(worktree.id, service.name, {
            ...viewOf(worktree, service, { _tag: "Waiting" }),
            sharedWith: shared.worktree.id
          })
          yield* demandShared(shared.worktree.id, service.name)
          return yield* Effect.all(
            [
              followSharedState(worktree, service, shared.worktree.id, readiness[service.name]!),
              followSharedRoute(worktree, service, shared.worktree.id)
            ],
            { concurrency: 2, discard: true }
          )
        }, Effect.scoped)

        const wakeOnRequest = (worktree: Worktree, service: ServiceNode, wakes: boolean) => {
          if (!wakes) return Effect.void
          if (service.exposure._tag !== "Routed") return Effect.void
          return waker.sleepUntilRequested(hostOf(worktree, service.name), pins.pin(worktree.id, service.name, "start"))
        }

        const sleepIfQuiet = (worktree: Worktree, service: ServiceNode, limit: number, after: Duration.Input) =>
          activity
            .quietFor(hostOf(worktree, service.name))
            .pipe(
              Effect.flatMap((quiet) =>
                quiet !== undefined && quiet > limit
                  ? pins
                      .unpin(worktree.id, service.name, "start")
                      .pipe(
                        Effect.andThen(
                          Effect.logInfo(
                            `${worktree.id}/${service.name} had no requests for ${Duration.format(Duration.fromInputUnsafe(after))}, so it sleeps until the next one`
                          )
                        )
                      )
                  : Effect.void
              )
            )

        const sleepWhenQuiet = (worktree: Worktree, services: ReadonlyArray<ServiceNode>, after: Duration.Input) => {
          const limit = Duration.toMillis(after)
          const routed = services.filter((service) => service.exposure._tag === "Routed")
          const nothing: readonly [ReadonlySet<string>, ReadonlySet<string>] = [new Set(), new Set()]
          const check = Stream.zipLatest(pins.changes(worktree.id, "own"), pins.changes(worktree.id, "start")).pipe(
            Stream.runHead,
            Effect.map(Option.getOrElse(() => nothing)),
            Effect.flatMap(([own, started]) =>
              Effect.forEach(
                routed.filter((service) => started.has(service.name) && !own.has(service.name)),
                (service) => sleepIfQuiet(worktree, service, limit, after),
                { discard: true }
              )
            )
          )
          return check.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped)
        }

        const asleep = (worktree: Worktree, service: ServiceNode, wakes: boolean) =>
          status
            .service(worktree.id, service.name, { ...viewOf(worktree, service, { _tag: "Waiting" }), asleep: true })
            .pipe(Effect.andThen(wakeOnRequest(worktree, service, wakes)), Effect.andThen(Effect.never), Effect.scoped)

        const gitIn = (id: WorktreeId, root: string, ...args: ReadonlyArray<string>) =>
          changes.exec(id, root, git(...args)).pipe(
            Effect.map((output) => output.trim()),
            Effect.mapError((error) => new InfraError({ infra: "shared", message: error.message }))
          )

        const sharedWorktreeOf = (worktree: Worktree): Worktree => {
          const branch = sharedBranch(worktree.profile)
          const id = worktreeId(branch, worktree.project)
          return {
            ...worktree,
            id,
            branch,
            root: path.join(options.sharedDir, `${worktree.project}-${branch}`) as Worktree["root"],
            domain: `${id}.${worktree.domain.slice(worktree.id.length + 1)}`
          }
        }

        const cloneShared = Effect.fn("Supervisor.cloneShared")(function* (origin: Worktree, shared: Worktree, ref: string) {
          yield* fs.makeDirectory(options.sharedDir, { recursive: true }).pipe(Effect.orDie)
          yield* gitIn(origin.id, options.sharedDir, "clone", "--quiet", "--shared", "--no-checkout", origin.root, shared.root)
          const commit = yield* gitIn(origin.id, origin.root, "rev-parse", ref)
          yield* gitIn(origin.id, shared.root, "checkout", "--quiet", "--detach", "--force", commit)
        })

        const ensureCheckout = Effect.fn("Supervisor.ensureCheckout")(function* (origin: Worktree, shared: Worktree, ref: string) {
          const present = yield* fs.exists(path.join(shared.root, ".git")).pipe(Effect.orElseSucceed(() => false))
          if (!present) yield* cloneShared(origin, shared, ref)
          return yield* gitIn(origin.id, shared.root, "rev-parse", "HEAD")
        })

        const startShared = Effect.fn("Supervisor.startShared")(function* (key: string) {
          const request = (yield* Ref.get(sharedRequests))[key]
          if (!request) return yield* new InfraError({ infra: "shared", message: `nothing asked for the shared stack ${key}` })
          const sharedRef = request.stack.shared?.ref ?? "origin/main"
          const shared = sharedWorktreeOf(request.worktree)
          const base = yield* SubscriptionRef.make(yield* ensureCheckout(request.worktree, shared, sharedRef))
          yield* status.register({
            id: shared.id,
            project: shared.project,
            branch: shared.branch,
            root: shared.root,
            profile: shared.profile
          })
          yield* Effect.addFinalizer(() => status.clear(shared.id))
          yield* runStack(request.stack, shared, "shared").pipe(
            Effect.scoped,
            Effect.tapCause((cause) => Effect.logError(`shared stack ${shared.id} stopped`, cause)),
            Effect.forkScoped
          )
          yield* Effect.logInfo(`shared stack ${shared.id} runs from ${shared.root} at ${(yield* SubscriptionRef.get(base)).slice(0, 10)}`)
          return { worktree: shared, base } satisfies SharedRun
        })

        const sharedRuns = yield* RcMap.make({ lookup: startShared, idleTimeToLive: "1 minute" })

        const joinShared = (stack: Stack, worktree: Worktree) =>
          Ref.update(sharedRequests, (all) => ({ ...all, [sharedKeyOf(worktree)]: { stack, worktree } })).pipe(
            Effect.andThen(RcMap.get(sharedRuns, sharedKeyOf(worktree)))
          )

        const followChanges = Effect.fnUntraced(function* (
          worktree: Worktree,
          session: Session,
          targets: ReadonlyArray<InputsTarget>,
          base: SubscriptionRef.SubscriptionRef<string>
        ) {
          const seen = yield* Ref.make<ReadonlySet<string>>(new Set())
          const refresh = SubscriptionRef.get(base).pipe(
            Effect.flatMap((commit) => session.touched(targets, commit)),
            Effect.flatMap((touched) =>
              Ref.getAndSet(seen, touched).pipe(
                Effect.flatMap((before) =>
                  Effect.forEach(
                    [...touched].filter((name) => !before.has(name)),
                    (name) =>
                      pins
                        .pin(worktree.id, name, "own")
                        .pipe(Effect.andThen(Effect.logInfo(`${worktree.id}: ${name} changed here, so it runs here`))),
                    { discard: true }
                  )
                )
              )
            ),
            Effect.catchCause((cause) => Effect.logWarning(`${worktree.id}: could not work out what changed`, cause))
          )
          yield* refresh
          const next = yield* changesUnder(worktree.root, { globs: ["**"], debounce: "1 second" }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path)
          )
          yield* next.pipe(Effect.andThen(refresh), Effect.forever, Effect.forkScoped)
        })

        const runStack = Effect.fnUntraced(function* (
          stack: Stack,
          worktree: Worktree,
          mode: "worktree" | "shared"
        ): Effect.fn.Return<never, unknown, Scope.Scope> {
          yield* Effect.annotateCurrentSpan(worktreeAttributes(worktree))
          const nodes = yield* stack.build(worktree)
          yield* plan(nodes)
          const infraNodes = nodes.filter(isInfra)
          const services = nodes.filter(isService)
          const specs = Object.fromEntries(infraNodes.map((node) => [node.spec.name, node.spec]))
          const common = new Set<string>(infraNodes.filter((node) => node.spec.sharedBy !== undefined).map((node) => node.spec.name))
          const everything = new Set([...services.map((service) => service.name), ...infraNodes.map((node) => node.spec.name)])
          const readiness = yield* readinessOf(services)
          const shared = mode === "worktree" && stack.shared ? yield* joinShared(stack, worktree) : undefined

          const local = yield* SubscriptionRef.make<ReadonlySet<string>>(shared ? new Set() : everything)
          const demanded = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set())

          const leases = yield* RcMap.make({
            lookup: (name: string) =>
              SubscriptionRef.get(local).pipe(
                Effect.flatMap((here) => acquireInfra(worktree, specs[name]!, here.has(name) || !shared ? worktree : shared.worktree))
              ),
            idleTimeToLive: "30 seconds"
          })

          const envOf = (service: ServiceNode): ServiceEnv =>
            Effect.forEach(service.uses, (name) => RcMap.get(leases, name)).pipe(
              Effect.map((envs) => envs.reduce<OwnedEnv>((all, next) => ({ ...all, ...next }), owned("forkyard.config", service.env)))
            )

          const placeLocal = Effect.fnUntraced(function* (next: ReadonlySet<string>) {
            const before = yield* SubscriptionRef.get(local)
            const moved = infraNodes.map((node) => node.spec.name).filter((name) => before.has(name) !== next.has(name))
            yield* Effect.forEach(moved, (name) => RcMap.invalidate(leases, name), { discard: true })
            yield* Effect.forEach(
              moved,
              (name) => Effect.logInfo(`${worktree.id}: ${name} ${next.has(name) ? "is now its own" : "is shared again"}`),
              {
                discard: true
              }
            )
            yield* SubscriptionRef.set(local, next)
          })

          const demand = (roots: ReadonlySet<string>) => SubscriptionRef.set(demanded, demandedNames(services, roots))

          if (mode === "shared") yield* demandedIn(worktree.id).pipe(Stream.runForEach(demand), Effect.forkScoped)
          if (mode === "worktree" && !shared) yield* demand(new Set(services.map((service) => service.name)))
          if (shared) {
            yield* sleepWhenQuiet(worktree, services, stack.shared?.sleepAfter ?? "20 minutes")
            yield* Stream.zipLatest(pins.changes(worktree.id, "own"), pins.changes(worktree.id, "start")).pipe(
              Stream.runForEach(([own, started]) =>
                placeLocal(localNames(services, own, common)).pipe(Effect.andThen(demand(rootsOf(services, own, started))))
              ),
              Effect.forkScoped
            )
            if (stack.inputs)
              yield* followChanges(
                worktree,
                yield* changes.session(stack.inputs, worktree),
                targetsOf(
                  services,
                  infraNodes.filter((node) => !common.has(node.spec.name))
                ),
                shared.base
              )
          }

          const infraMoved = (service: ServiceNode) =>
            signalOnChange(
              SubscriptionRef.changes(local).pipe(
                Stream.map((here) => service.uses.map((name) => here.has(name)).join(",")),
                Stream.changes
              )
            )

          const placementOf = (service: ServiceNode) =>
            Stream.zipLatest(SubscriptionRef.changes(demanded), SubscriptionRef.changes(local)).pipe(
              Stream.map(([wanted, here]): Placement => {
                if (!wanted.has(service.name)) return "asleep"
                if (!shared || here.has(service.name)) return "local"
                return "shared"
              }),
              Stream.changes
            )

          const runAs = (service: ServiceNode) => (placement: Placement) => {
            if (placement === "asleep") return asleep(worktree, service, shared !== undefined)
            if (placement === "shared" && shared) return useShared(worktree, service, shared, readiness).pipe(Effect.andThen(Effect.never))
            return Effect.gen(function* () {
              yield* supervise(worktree, service, envOf(service), readiness, yield* infraMoved(service))
              return yield* Effect.never
            }).pipe(Effect.scoped)
          }

          yield* Effect.addFinalizer(() => env.forget(worktree.id))
          yield* Ref.update(running, (all) => ({ ...all, [worktree.id]: { stack, worktree } }))
          yield* Effect.addFinalizer(() =>
            Ref.update(running, (all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== worktree.id)))
          )
          yield* Effect.forEach(
            services,
            (service) =>
              placementOf(service).pipe(
                Stream.switchMap((placement) => Stream.fromEffect(runAs(service)(placement))),
                Stream.runDrain,
                Effect.forkScoped
              ),
            { discard: true }
          )

          return yield* Effect.never
        })

        const updateShared = Effect.fn("Supervisor.updateShared")(function* (id: WorktreeId) {
          const entry = (yield* Ref.get(running))[id]
          if (!entry) return yield* new InfraError({ infra: "shared", message: `${id} is not running` })
          if (!entry.stack.shared) return yield* new InfraError({ infra: "shared", message: `${entry.stack.name} does not share services` })
          const shared = sharedWorktreeOf(entry.worktree)
          const commit = yield* gitIn(id, entry.worktree.root, "rev-parse", entry.stack.shared.ref)
          yield* gitIn(id, shared.root, "checkout", "--quiet", "--detach", "--force", commit)
          const sharedRun = yield* RcMap.get(sharedRuns, sharedKeyOf(entry.worktree)).pipe(Effect.scoped)
          yield* SubscriptionRef.set(sharedRun.base, commit)
          const names = Object.keys((yield* status.snapshot)[shared.id]?.services ?? {})
          yield* Effect.forEach(names, (name) => PubSub.publish(restarts, `${shared.id}/${name}`), { discard: true })
          return `${shared.id} now runs ${entry.stack.shared.ref} (${commit.slice(0, 10)}); its running services are restarting`
        })

        return Supervisor.of({
          run: (stack, worktree) => runStack(stack, worktree, "worktree"),
          restart: (id, service) => PubSub.publish(restarts, restartKey(id, service)).pipe(Effect.asVoid),
          own: (id, service) => pins.pin(id, service, "own"),
          share: (id, service) => pins.unpin(id, service, "own"),
          start: (id, service) => pins.pin(id, service, "start"),
          stop: (id, service) => pins.unpin(id, service, "start"),
          updateShared,
          infraAction
        })
      })
    )
}
