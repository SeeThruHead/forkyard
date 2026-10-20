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
  Path,
  PubSub,
  Schema,
  Ref,
  Semaphore,
  type Scope,
  Stream
} from "effect"
import { HttpClient } from "effect/http"
import { daemonEnv, EnvResolver, owned, type OwnedEnv, telemetryDefaults } from "./Env.ts"
import type { InfraName, Port, ServiceName, WorktreeId } from "./Ids.ts"
import { ownerOfWorktree } from "./Ids.ts"
import { InfraManager } from "./InfraManager.ts"
import { infraKey, instanceKey, Instances } from "./Instances.ts"
import * as Metrics from "./Metrics.ts"
import type { RunRef, ServiceState, ServiceView } from "./Model.ts"
import { plan } from "./Plan.ts"
import { allocatePort } from "./Ports.ts"
import { Proc, type Spawned } from "./Proc.ts"
import { pollUntilReady, unlessItExits } from "./Readiness.ts"
import { Router } from "./Router.ts"
import { shareableInfra, shareableServices, Sharing } from "./Sharing.ts"
import {
  hostOf,
  InfraError,
  type InfraNode,
  type InfraServer,
  type InfraSpec,
  type Node,
  type OnExit,
  type ServiceNode,
  type Stack,
  urlOf,
  type Watch,
  type Worktree
} from "./Stack.ts"
import { Status } from "./Status.ts"
import { changesUnder } from "./Watch.ts"

export class BaseGone extends Schema.TaggedError<BaseGone>()("BaseGone", {
  base: Schema.String
}) {}

export class DependencyFailed extends Schema.TaggedError<DependencyFailed>()("DependencyFailed", {
  service: Schema.String
}) {}

type Ready = Deferred.Deferred<void, DependencyFailed>

type Readiness = Readonly<Record<string, Ready>>

type InfraEnv = Readonly<Record<InfraName, OwnedEnv>>

type Outcome =
  | { readonly _tag: "Exited"; readonly code: number }
  | { readonly _tag: "RestartRequested" }
  | { readonly _tag: "FilesChanged" }

type Finished = { readonly run: RunRef; readonly code: number }

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
  "forkyard.lifecycle": service.lifecycle._tag,
  "forkyard.exposure": service.exposure._tag
})

const viewOf = (worktree: Worktree, service: ServiceNode, state: ServiceState): ServiceView => {
  if (service.exposure._tag === "Routed") return { _tag: "Http", url: urlOf(worktree, service.name), state }
  if (service.lifecycle._tag === "RunOnce") return { _tag: "Task", state }
  return { _tag: "Worker", state }
}

const ownedEnvFor = (service: ServiceNode, infraEnv: InfraEnv): OwnedEnv => ({
  ...service.uses.reduce<OwnedEnv>((all, name) => ({ ...all, ...infraEnv[name] }), {}),
  ...owned("forkyard.config", service.env)
})

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

export class Supervisor extends Context.Service<
  Supervisor,
  {
    readonly run: (stack: Stack, worktree: Worktree, base: Worktree | undefined) => Effect.Effect<never, unknown, Scope.Scope>
    readonly restart: (id: WorktreeId, service: ServiceName) => Effect.Effect<void>
    readonly infraAction: (id: WorktreeId, infra: InfraName, action: string) => Effect.Effect<string, InfraError>
  }
>()("forkyard/Supervisor") {
  static readonly layer = (options: {
    readonly startupConcurrency: number
    readonly otlpUrl: string | undefined
    readonly otlpHeaders: string
  }) =>
    Layer.effect(
      Supervisor,
      Effect.gen(function* () {
        const infra = yield* InfraManager
        const instances = yield* Instances
        const sharing = yield* Sharing
        const proc = yield* Proc
        const router = yield* Router
        const status = yield* Status
        const env = yield* EnvResolver
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const basePath = yield* Config.String("PATH").pipe(Config.withDefault(""))
        const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
        const startup = yield* Semaphore.make(options.startupConcurrency)
        const restarts = yield* PubSub.unbounded<string>()
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
              "forkyard.infra.scope": spec.scope
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

            return [spec.name, owned(`infra:${spec.name}`, lease.env)] as const
          },
          (effect, worktree, spec) =>
            effect.pipe(
              Effect.tapError((error) =>
                status.infra(worktree.id, spec.name, { _tag: "InfraFailed", scope: spec.scope, reason: String(error) })
              )
            )
        )

        const publishedBy = (owner: Worktree | undefined, names: ReadonlyArray<string>, keyOf: (id: WorktreeId, name: string) => string) =>
          Effect.forEach(names, (name) =>
            owner
              ? instances.get(keyOf(owner.id, name)).pipe(Effect.map((instance) => [name, instance?.fingerprint] as const))
              : Effect.succeed([name, undefined] as const)
          ).pipe(
            Effect.map((entries): Readonly<Record<string, string>> =>
              Object.fromEntries(entries.flatMap(([name, fingerprint]) => (fingerprint ? [[name, fingerprint] as const] : [])))
            )
          )

        const publish = (
          worktree: Worktree,
          fingerprints: Readonly<Record<string, string>>,
          keyOf: (id: WorktreeId, name: string) => string
        ) =>
          Effect.forEach(
            Object.entries(fingerprints),
            ([name, fingerprint]) => instances.publish(keyOf(worktree.id, name), { fingerprint, port: undefined }),
            {
              discard: true
            }
          )

        const prepare = Effect.fn("Supervisor.prepare")(function* (stack: Stack, worktree: Worktree, base: Worktree | undefined) {
          yield* Effect.annotateCurrentSpan(worktreeAttributes(worktree))

          const nodes = yield* stack.build(worktree)
          yield* plan(nodes)
          const infraNodes = nodes.filter(isInfra)
          const services = nodes.filter(isService)
          const session = stack.inputs ? yield* sharing.session(stack.inputs, worktree) : undefined

          const infraFingerprints = session ? yield* session.infra(infraNodes) : {}
          const sharedInfra = shareableInfra(
            infraNodes,
            infraFingerprints,
            yield* publishedBy(
              base,
              infraNodes.map((node) => node.spec.name),
              infraKey
            )
          )
          yield* publish(worktree, infraFingerprints, infraKey)

          const tenantFor = (spec: InfraSpec) => (base && sharedInfra.has(spec.name) ? base : worktree)
          const leases = yield* Effect.forEach(infraNodes, (node) => acquireInfra(worktree, node.spec, tenantFor(node.spec)), {
            concurrency: "unbounded"
          })
          const infraEnv = Object.fromEntries(leases) as InfraEnv

          const measured = session
            ? yield* session.services({
                services,
                infra: infraFingerprints,
                envOf: (service) => resolveEnv(worktree, service, ownedEnvFor(service, infraEnv), undefined)
              })
            : { fingerprints: {}, references: {} }
          const shared = shareableServices({
            services,
            infra: sharedInfra,
            mine: measured.fingerprints,
            base: yield* publishedBy(
              base,
              services.map((service) => service.name),
              instanceKey
            ),
            references: measured.references
          })
          yield* publish(
            worktree,
            Object.fromEntries(Object.entries(measured.fingerprints).filter(([name]) => !shared.has(name))),
            instanceKey
          )
          if (base)
            yield* Effect.logInfo(
              `${worktree.id} shares ${shared.size} of ${services.length} services and ${sharedInfra.size} infra with ${base.id}`
            )

          return { services, infraEnv, shared }
        })

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
          ownedEnv: OwnedEnv
        ) {
          yield* Effect.annotateCurrentSpan(serviceAttributes(worktree, service))
          yield* setState(worktree, service, { _tag: "Preparing" })

          const port = service.exposure._tag === "Routed" ? yield* allocatePort : undefined
          yield* instances.setPort(instanceKey(worktree.id, service.name), port)
          const extraPorts = yield* allocateNamedPorts(service)
          const spawned = yield* spawnProcess(worktree, service, yield* resolveEnv(worktree, service, { ...ownedEnv, ...extraPorts }, port))
          yield* Effect.annotateCurrentSpan({ "forkyard.run": spawned.run.run, "process.pid": spawned.pid })
          yield* setState(worktree, service, { _tag: "Starting", run: spawned.run })

          if (port) yield* router.expose({ host: hostOf(worktree, service.name), port })
          yield* awaitReadiness(service, spawned, port)
          if (port && service.exposure._tag === "Routed") yield* waitRouted(urlOf(worktree, service.name), service.exposure.health)

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
          ownedEnv: OwnedEnv,
          ready: Ready,
          nextChange: Effect.Effect<void>
        ) {
          const restartWanted = yield* restartRequested(worktree, service)
          const began = yield* Clock.currentTimeMillis
          const spawned = yield* withStartSlot(startProcess(worktree, service, ownedEnv))

          yield* markReady(worktree, service, spawned.run, ready, began)

          const changed = nextChange.pipe(Effect.as<Outcome>({ _tag: "FilesChanged" }))
          const outcome = yield* Effect.raceAll([exitOutcome(spawned), restartWanted, changed])
          const restarting = shouldRestart(onExit, outcome)
          yield* markEnded(worktree, service, spawned.run, outcome, restarting)

          return restarting
        }, Effect.scoped)

        const keepRunning = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          lifecycle: { readonly onExit: OnExit; readonly watch: Watch | undefined },
          ownedEnv: OwnedEnv,
          ready: Ready
        ) {
          const nextChange = yield* watching(worktree, lifecycle.watch)
          const failed = (cause: Cause.Cause<unknown>) => setState(worktree, service, { _tag: "Failed", reason: reasonOf(cause) })

          const attempt = (failures: number): Effect.Effect<void> =>
            runLongRunning(worktree, service, lifecycle.onExit, ownedEnv, ready, nextChange).pipe(
              Effect.map((again): Attempt => ({ again, failures: 0 })),
              Effect.catchCause((cause) => failed(cause).pipe(Effect.as<Attempt>({ again: true, failures: failures + 1 }))),
              Effect.flatMap((next) =>
                next.again ? Effect.sleep(restartDelay(next.failures)).pipe(Effect.andThen(attempt(next.failures))) : Effect.void
              )
            )

          return yield* attempt(0)
        })

        const runToExit = Effect.fnUntraced(function* (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv) {
          const spawned = yield* spawnProcess(worktree, service, yield* resolveEnv(worktree, service, ownedEnv, undefined))
          yield* setState(worktree, service, { _tag: "Starting", run: spawned.run })

          return { run: spawned.run, code: yield* spawned.exited } satisfies Finished
        }, Effect.scoped)

        const runOnce = Effect.fn("Supervisor.runTask", { root: true })(function* (
          worktree: Worktree,
          service: ServiceNode,
          ownedEnv: OwnedEnv
        ) {
          yield* Effect.annotateCurrentSpan(serviceAttributes(worktree, service))
          yield* setState(worktree, service, { _tag: "Preparing" })

          const finished = yield* withStartSlot(runToExit(worktree, service, ownedEnv))
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

        const runTaskOnce = (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv, ready: Ready) =>
          runOnce(worktree, service, ownedEnv).pipe(Effect.flatMap(recordFinished(worktree, service, ready)))

        const rerunOnChange = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          watch: Watch,
          ownedEnv: OwnedEnv,
          ready: Ready
        ) {
          const nextChange = yield* watching(worktree, watch)

          return yield* runTaskOnce(worktree, service, ownedEnv, ready).pipe(Effect.andThen(nextChange), Effect.forever)
        })

        const runTask = (worktree: Worktree, service: ServiceNode, watch: Watch | undefined, ownedEnv: OwnedEnv, ready: Ready) =>
          watch ? rerunOnChange(worktree, service, watch, ownedEnv, ready) : runTaskOnce(worktree, service, ownedEnv, ready)

        const failDependents = (worktree: Worktree, service: ServiceNode, readiness: Readiness) => (failed: DependencyFailed) =>
          Effect.all(
            [
              setState(worktree, service, { _tag: "Failed", reason: `${failed.service} failed` }),
              Deferred.fail(readiness[service.name]!, new DependencyFailed({ service: service.name }))
            ],
            { discard: true }
          )

        const supervise = Effect.fnUntraced(
          function* (worktree: Worktree, service: ServiceNode, infraEnv: InfraEnv, readiness: Readiness) {
            const ready = readiness[service.name]!
            const ownedEnv = ownedEnvFor(service, infraEnv)

            yield* status.service(worktree.id, service.name, viewOf(worktree, service, { _tag: "Waiting" }))
            yield* awaitDependencies(service, readiness)

            if (service.lifecycle._tag === "RunOnce") return yield* runTask(worktree, service, service.lifecycle.watch, ownedEnv, ready)
            return yield* keepRunning(worktree, service, service.lifecycle, ownedEnv, ready)
          },
          (effect, worktree, service, _infraEnv, readiness) =>
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

        const followState = (worktree: Worktree, service: ServiceNode, base: Worktree, ready: Ready) =>
          status.changes.pipe(
            Stream.map((snapshot) => snapshot[base.id]?.services[service.name]?.state),
            Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
            Stream.runForEach((state) => (state ? mirror(worktree, service, ready)(state) : Effect.fail(new BaseGone({ base: base.id }))))
          )

        const routeTo = (worktree: Worktree, service: ServiceNode, port: Port) =>
          Stream.scoped(Stream.fromEffect(router.expose({ host: hostOf(worktree, service.name), port })).pipe(Stream.concat(Stream.never)))

        const followRoute = (worktree: Worktree, service: ServiceNode, base: Worktree) => {
          if (service.exposure._tag !== "Routed") return Effect.never
          return instances.watch(instanceKey(base.id, service.name)).pipe(
            Stream.switchMap((instance) => {
              if (!instance) return Stream.fail(new BaseGone({ base: base.id }))
              return instance.port ? routeTo(worktree, service, instance.port) : Stream.empty
            }),
            Stream.runDrain
          )
        }

        const superviseShared = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          base: Worktree,
          readiness: Readiness
        ) {
          yield* status.service(worktree.id, service.name, { ...viewOf(worktree, service, { _tag: "Waiting" }), sharedWith: base.id })
          yield* Effect.all([followState(worktree, service, base, readiness[service.name]!), followRoute(worktree, service, base)], {
            concurrency: 2,
            discard: true
          })
        })

        const run = Effect.fnUntraced(function* (
          stack: Stack,
          worktree: Worktree,
          base: Worktree | undefined
        ): Effect.fn.Return<never, unknown, Scope.Scope> {
          const { services, infraEnv, shared } = yield* prepare(stack, worktree, base)
          const readiness = yield* readinessOf(services)
          const baseLost = yield* Deferred.make<void>()
          const loseBase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(Effect.catch((error) => (error instanceof BaseGone ? Deferred.succeed(baseLost, undefined) : Effect.fail(error))))

          yield* Effect.addFinalizer(() => env.forget(worktree.id))
          yield* Effect.forEach(
            services,
            (service) =>
              base && shared.has(service.name)
                ? superviseShared(worktree, service, base, readiness).pipe(loseBase, Effect.forkScoped)
                : supervise(worktree, service, infraEnv, readiness).pipe(Effect.forkScoped),
            { discard: true }
          )

          yield* Deferred.await(baseLost)
          return yield* new BaseGone({ base: base?.id ?? "" })
        })

        return Supervisor.of({
          run,
          restart: (id, service) => PubSub.publish(restarts, restartKey(id, service)).pipe(Effect.asVoid),
          infraAction
        })
      })
    )
}
