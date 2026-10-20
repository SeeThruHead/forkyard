import {
  Cause,
  Clock,
  Config,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Metric,
  Path,
  PubSub,
  Queue,
  Schema,
  Ref,
  Semaphore,
  Scope,
  Stream,
  SubscriptionRef
} from "effect"
import { HttpClient } from "effect/http"
import { daemonEnv, EnvResolver, owned, type OwnedEnv, telemetryDefaults } from "./Env.ts"
import { BranchSlug, type InfraName, ownerOfWorktree, type Port, ServiceName, type WorktreeId, worktreeId } from "./Ids.ts"
import { InfraManager } from "./InfraManager.ts"
import { type Found, instanceKey, Instances } from "./Instances.ts"
import * as Metrics from "./Metrics.ts"
import type { RunRef, ServiceState, ServiceView } from "./Model.ts"
import { plan } from "./Plan.ts"
import { allocatePort } from "./Ports.ts"
import { Proc, type Spawned } from "./Proc.ts"
import { pollUntilReady, unlessItExits } from "./Readiness.ts"
import { Router } from "./Router.ts"
import { type Refreshed, type Session, sharedTasksAllowed, Sharing } from "./Sharing.ts"
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

export class LenderGone extends Schema.TaggedError<LenderGone>()("LenderGone", {
  service: Schema.String
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

type Lease = {
  readonly spec: InfraSpec
  readonly fingerprint: string | undefined
  readonly env: OwnedEnv
  readonly scope: Scope.Closeable
}

const envOfLeases = (leases: ReadonlyArray<Lease>): InfraEnv => Object.fromEntries(leases.map((lease) => [lease.spec.name, lease.env]))

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
    readonly run: (stack: Stack, worktree: Worktree) => Effect.Effect<never, unknown, Scope.Scope>
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
        const decisions = yield* Semaphore.make(1)
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

        const tenantFor = (worktree: Worktree, fingerprint: string | undefined): Worktree => {
          if (!fingerprint) return worktree
          const branch = BranchSlug.make(`shared-${fingerprint.slice(0, 10)}`)
          const id = worktreeId(branch, worktree.project)
          return { ...worktree, id, branch, domain: `${id}.${worktree.domain.slice(worktree.id.length + 1)}` }
        }

        const publishOwn = (worktree: Worktree, name: string, fingerprint: string | undefined) =>
          fingerprint
            ? instances.publish(instanceKey(worktree.id, name), { fingerprint, owner: worktree.id, port: undefined })
            : Effect.void

        const claim = Effect.fnUntraced(function* (
          worktree: Worktree,
          services: ReadonlyArray<ServiceNode>,
          fingerprints: Readonly<Record<string, string>>
        ) {
          const found = yield* Effect.forEach(services, (service) => {
            const fingerprint = fingerprints[service.name]
            return fingerprint
              ? instances.find(fingerprint, worktree.id).pipe(Effect.map((match) => [service.name, match] as const))
              : Effect.succeed([service.name, undefined] as const)
          })
          const matched = Object.fromEntries(found.flatMap(([name, match]) => (match ? [[name, match] as const] : [])))
          const keep = sharedTasksAllowed(services, new Set(Object.keys(matched)))
          const lenders = Object.fromEntries(Object.entries(matched).filter(([name]) => keep.has(name)))
          yield* Effect.forEach(
            services.filter((service) => !lenders[service.name]),
            (service) => publishOwn(worktree, service.name, fingerprints[service.name]),
            { discard: true }
          )
          return lenders as Readonly<Record<string, Found>>
        })

        const describeSharing = (worktree: Worktree, services: ReadonlyArray<ServiceNode>, lenders: Readonly<Record<string, Found>>) => {
          const owners = [...new Set(Object.values(lenders).map((found) => found.instance.owner))]
          const own = services.filter((service) => !lenders[service.name]).map((service) => service.name)
          return `${worktree.id} shares ${Object.keys(lenders).length} of ${services.length} services${owners.length > 0 ? ` (running under ${owners.join(", ")})` : ""}; runs its own: ${own.join(", ") || "nothing"}`
        }

        const leaseInfra = Effect.fnUntraced(function* (
          parent: Scope.Scope,
          worktree: Worktree,
          spec: InfraSpec,
          fingerprint: string | undefined
        ) {
          const scope = yield* Scope.fork(parent, "sequential")
          const [, env] = yield* acquireInfra(worktree, spec, tenantFor(worktree, fingerprint)).pipe(Scope.provide(scope))
          return { spec, fingerprint, env, scope } satisfies Lease
        })

        const prepare = Effect.fn("Supervisor.prepare")(function* (stack: Stack, worktree: Worktree) {
          yield* Effect.annotateCurrentSpan(worktreeAttributes(worktree))

          const nodes = yield* stack.build(worktree)
          yield* plan(nodes)
          const infraNodes = nodes.filter(isInfra)
          const services = nodes.filter(isService)
          const session = stack.inputs ? yield* sharing.session(stack.inputs, worktree) : undefined

          const infraFingerprints = session ? yield* session.infra(infraNodes) : {}
          const runScope = yield* Effect.scope
          const leases = yield* Effect.forEach(
            infraNodes,
            (node) => leaseInfra(runScope, worktree, node.spec, infraFingerprints[node.spec.name]),
            { concurrency: "unbounded" }
          )
          const infraEnv = envOfLeases(leases)

          const measured = session
            ? yield* session.services({
                services,
                infra: infraFingerprints,
                envOf: (service) => resolveEnv(worktree, service, ownedEnvFor(service, infraEnv), undefined)
              })
            : { fingerprints: {}, unexplained: [] }
          if (measured.unexplained.length > 0)
            yield* Effect.logWarning(
              `${worktree.id}: env points at other services without saying whether it calls them, so they count as calls. Add each to that service's calls or links: ${measured.unexplained.join(", ")}`
            )
          const fingerprints = measured.fingerprints
          const lenders = yield* decisions.withPermits(1)(claim(worktree, services, fingerprints))
          if (session) yield* Effect.logInfo(describeSharing(worktree, services, lenders))

          return { services, infraEnv, leases, lenders, fingerprints, session }
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
          ownedEnv: Effect.Effect<OwnedEnv>
        ) {
          yield* Effect.annotateCurrentSpan(serviceAttributes(worktree, service))
          yield* setState(worktree, service, { _tag: "Preparing" })

          const port = service.exposure._tag === "Routed" ? yield* allocatePort : undefined
          yield* instances.setPort(instanceKey(worktree.id, service.name), port)
          const extraPorts = yield* allocateNamedPorts(service)
          const spawned = yield* spawnProcess(
            worktree,
            service,
            yield* resolveEnv(worktree, service, { ...(yield* ownedEnv), ...extraPorts }, port)
          )
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
          ownedEnv: Effect.Effect<OwnedEnv>,
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

          return { again: restarting, crashed: outcome._tag === "Exited" && outcome.code !== 0 }
        }, Effect.scoped)

        const keepRunning = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          lifecycle: { readonly onExit: OnExit; readonly watch: Watch | undefined },
          ownedEnv: Effect.Effect<OwnedEnv>,
          ready: Ready,
          codeChanged: Effect.Effect<void>
        ) {
          const nextChange = Effect.raceFirst(yield* watching(worktree, lifecycle.watch), codeChanged)
          const failed = (cause: Cause.Cause<unknown>) => setState(worktree, service, { _tag: "Failed", reason: reasonOf(cause) })

          const attempt = (failures: number): Effect.Effect<void> =>
            runLongRunning(worktree, service, lifecycle.onExit, ownedEnv, ready, nextChange).pipe(
              Effect.map(({ again, crashed }): Attempt => ({ again, failures: crashed ? failures + 1 : 0 })),
              Effect.catchCause((cause) => failed(cause).pipe(Effect.as<Attempt>({ again: true, failures: failures + 1 }))),
              Effect.flatMap((next) =>
                next.again ? Effect.sleep(restartDelay(next.failures)).pipe(Effect.andThen(attempt(next.failures))) : Effect.void
              )
            )

          return yield* attempt(0)
        })

        const runToExit = Effect.fnUntraced(function* (worktree: Worktree, service: ServiceNode, ownedEnv: Effect.Effect<OwnedEnv>) {
          const spawned = yield* spawnProcess(worktree, service, yield* resolveEnv(worktree, service, yield* ownedEnv, undefined))
          yield* setState(worktree, service, { _tag: "Starting", run: spawned.run })

          return { run: spawned.run, code: yield* spawned.exited } satisfies Finished
        }, Effect.scoped)

        const runOnce = Effect.fn("Supervisor.runTask", { root: true })(function* (
          worktree: Worktree,
          service: ServiceNode,
          ownedEnv: Effect.Effect<OwnedEnv>
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

        const runTaskOnce = (worktree: Worktree, service: ServiceNode, ownedEnv: Effect.Effect<OwnedEnv>, ready: Ready) =>
          runOnce(worktree, service, ownedEnv).pipe(Effect.flatMap(recordFinished(worktree, service, ready)))

        const runTask = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          watch: Watch | undefined,
          ownedEnv: Effect.Effect<OwnedEnv>,
          ready: Ready,
          codeChanged: Effect.Effect<void>
        ) {
          const nextChange = Effect.raceFirst(yield* watching(worktree, watch), codeChanged)

          return yield* runTaskOnce(worktree, service, ownedEnv, ready).pipe(Effect.andThen(nextChange), Effect.forever)
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
          function* (
            worktree: Worktree,
            service: ServiceNode,
            infraEnv: Effect.Effect<InfraEnv>,
            readiness: Readiness,
            codeChanged: Effect.Effect<void>
          ) {
            const ready = readiness[service.name]!
            const ownedEnv = infraEnv.pipe(Effect.map((current) => ownedEnvFor(service, current)))

            yield* status.service(worktree.id, service.name, viewOf(worktree, service, { _tag: "Waiting" }))
            yield* awaitDependencies(service, readiness)

            if (service.lifecycle._tag === "RunOnce")
              return yield* runTask(worktree, service, service.lifecycle.watch, ownedEnv, ready, codeChanged)
            return yield* keepRunning(worktree, service, service.lifecycle, ownedEnv, ready, codeChanged)
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

        const lenderName = (found: Found) => ServiceName.make(found.key.slice(found.instance.owner.length + 1))

        const followState = (worktree: Worktree, service: ServiceNode, found: Found, ready: Ready) =>
          status.changes.pipe(
            Stream.map((snapshot) => snapshot[found.instance.owner]?.services[lenderName(found)]?.state),
            Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
            Stream.runForEach((state) =>
              state ? mirror(worktree, service, ready)(state) : Effect.fail(new LenderGone({ service: service.name }))
            )
          )

        const routeTo = (worktree: Worktree, service: ServiceNode, port: Port) =>
          Stream.scoped(Stream.fromEffect(router.expose({ host: hostOf(worktree, service.name), port })).pipe(Stream.concat(Stream.never)))

        const followRoute = (worktree: Worktree, service: ServiceNode, found: Found, mine: Stream.Stream<string | undefined>) =>
          Stream.zipLatest(instances.watch(found.key), mine).pipe(
            Stream.switchMap(([instance, fingerprint]) => {
              if (!instance) return Stream.fail(new LenderGone({ service: service.name }))
              if (instance.fingerprint !== fingerprint) return Stream.fail(new LenderGone({ service: service.name }))
              if (service.exposure._tag !== "Routed" || !instance.port) return Stream.never
              return routeTo(worktree, service, instance.port)
            }),
            Stream.runDrain
          )

        const borrow = Effect.fnUntraced(function* (
          worktree: Worktree,
          service: ServiceNode,
          found: Found,
          readiness: Readiness,
          mine: Stream.Stream<string | undefined>
        ) {
          yield* status.service(worktree.id, service.name, {
            ...viewOf(worktree, service, { _tag: "Waiting" }),
            sharedWith: found.instance.owner
          })
          yield* Effect.all(
            [followState(worktree, service, found, readiness[service.name]!), followRoute(worktree, service, found, mine)],
            {
              concurrency: 2,
              discard: true
            }
          )
        })

        const followCode = (worktree: Worktree, session: Session, apply: (refreshed: Refreshed) => Effect.Effect<void, unknown>) =>
          changesUnder(worktree.root, { globs: ["**"], debounce: "1 second" }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.flatMap((next) =>
              next.pipe(
                Effect.andThen(session.refresh),
                Effect.flatMap(apply),
                Effect.catchCause((cause) => Effect.logWarning(`${worktree.id}: could not recompute fingerprints`, cause)),
                Effect.forever
              )
            ),
            Effect.forkScoped
          )

        const signalOnChange = Effect.fnUntraced(function* (changes: Stream.Stream<string | undefined>) {
          const signals = yield* Queue.sliding<void>(1)
          yield* changes.pipe(
            Stream.drop(1),
            Stream.runForEach(() => Queue.offer(signals, undefined)),
            Effect.forkScoped
          )
          return Queue.take(signals).pipe(Effect.asVoid)
        })

        const run = Effect.fnUntraced(function* (stack: Stack, worktree: Worktree): Effect.fn.Return<never, unknown, Scope.Scope> {
          const { services, infraEnv, leases, lenders, fingerprints, session } = yield* prepare(stack, worktree)
          const runScope = yield* Effect.scope
          const readiness = yield* readinessOf(services)
          const current = yield* SubscriptionRef.make(fingerprints)
          const leased = yield* Ref.make(leases)
          const infraNow = yield* Ref.make(infraEnv)

          const moveInfra = (lease: Lease, fingerprint: string | undefined) =>
            Effect.logInfo(`${worktree.id}: ${lease.spec.name} changed; moving to a new ${lease.spec.name}`).pipe(
              Effect.andThen(leaseInfra(runScope, worktree, lease.spec, fingerprint))
            )

          const applyRefresh = Effect.fnUntraced(function* (refreshed: Refreshed) {
            const before = yield* Ref.get(leased)
            const changed = before.filter((lease) => refreshed.infra[lease.spec.name] !== lease.fingerprint)
            const moved = yield* Effect.forEach(changed, (lease) => moveInfra(lease, refreshed.infra[lease.spec.name]), {
              concurrency: "unbounded"
            })
            const after = [...before.filter((lease) => !changed.includes(lease)), ...moved]
            yield* Ref.set(leased, after)
            yield* Ref.set(infraNow, envOfLeases(after))
            yield* SubscriptionRef.set(current, refreshed.services)
            yield* Effect.forEach(changed, (lease) => Scope.close(lease.scope, Exit.void), { discard: true })
          })

          if (session) yield* followCode(worktree, session, applyRefresh)

          const mine = (service: ServiceNode) =>
            SubscriptionRef.changes(current).pipe(
              Stream.map((all) => all[service.name]),
              Stream.changes
            )

          const own = Effect.fnUntraced(function* (service: ServiceNode) {
            const key = instanceKey(worktree.id, service.name)
            yield* mine(service).pipe(
              Stream.runForEach((fingerprint) => (fingerprint ? instances.setFingerprint(key, fingerprint) : Effect.void)),
              Effect.forkScoped
            )
            const codeChanged = service.reloads ? Effect.never : yield* signalOnChange(mine(service))
            return yield* supervise(worktree, service, Ref.get(infraNow), readiness, codeChanged)
          })

          const reclaim = (service: ServiceNode) =>
            decisions.withPermits(1)(
              SubscriptionRef.get(current).pipe(
                Effect.flatMap((all) => {
                  const fingerprint = all[service.name]
                  const find = fingerprint ? instances.find(fingerprint, worktree.id) : Effect.succeed(undefined)
                  return find.pipe(Effect.tap((found) => (found ? Effect.void : publishOwn(worktree, service.name, fingerprint))))
                })
              )
            )

          const moveOn = (service: ServiceNode): Effect.Effect<void, unknown, Scope.Scope> =>
            reclaim(service).pipe(
              Effect.flatMap((found) =>
                found
                  ? Effect.logInfo(`${worktree.id}/${service.name} now uses the copy running under ${found.instance.owner}`).pipe(
                      Effect.andThen(shareOrOwn(service, found))
                    )
                  : Effect.logInfo(`${worktree.id}/${service.name} starts its own copy`).pipe(Effect.andThen(own(service)))
              )
            )

          const shareOrOwn = (service: ServiceNode, found: Found | undefined): Effect.Effect<void, unknown, Scope.Scope> => {
            if (!found) return own(service)
            return borrow(worktree, service, found, readiness, mine(service)).pipe(
              Effect.catch((error) => (error instanceof LenderGone ? moveOn(service) : Effect.fail(error)))
            )
          }

          yield* Effect.addFinalizer(() => env.forget(worktree.id))
          yield* Effect.forEach(services, (service) => shareOrOwn(service, lenders[service.name]).pipe(Effect.forkScoped), {
            discard: true
          })

          return yield* Effect.never
        })

        return Supervisor.of({
          run,
          restart: (id, service) => PubSub.publish(restarts, restartKey(id, service)).pipe(Effect.asVoid),
          infraAction
        })
      })
    )
}
