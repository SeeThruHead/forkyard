import { Clock, Context, Deferred, Effect, FileSystem, Layer, Metric, Option, PubSub, Ref, Schedule, Schema, Semaphore, type Scope } from "effect"
import { HttpClient } from "effect/http"
import { EnvError, type EnvEntry, type EnvLoadContext, looksSensitive } from "./EnvSource.ts"
import { InfraManager } from "./InfraManager.ts"
import * as Metrics from "./Metrics.ts"
import type { EnvVar } from "./Model.ts"
import { nodeName, plan } from "./Plan.ts"
import { Ports } from "./Ports.ts"
import { Proc } from "./Proc.ts"
import { Router } from "./Router.ts"
import { type Env, hostOf, type InfraNode, type Node, type ServiceNode, type Stack, urlOf, type Worktree } from "./Stack.ts"
import { Status } from "./Status.ts"

export class TaskFailed extends Schema.TaggedError<TaskFailed>()("TaskFailed", {
  service: Schema.String,
  exitCode: Schema.Number
}) {}

type Owned = { readonly value: string; readonly source: string }
type Sourced = EnvEntry & { readonly source: string }

const isService = (node: Node): node is ServiceNode => node._tag === "Service"
const isInfra = (node: Node): node is InfraNode => node._tag === "Infra"
const envKey = (worktree: string, service: string) => `${worktree}/${service}`
const fixedPort = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/

const visibleToSources = (key: string) => !key.startsWith("OTEL_") && key !== "NODE_OPTIONS"

const redact = (value: string) => (value.length <= 4 ? "****" : `${value.slice(0, 2)}****${value.slice(-2)}`)

const warningFor = (key: string, value: string) =>
  fixedPort.test(value) ? `${key} points at a fixed port. Map it in forkyard.config.ts so each worktree gets its own.` : undefined

export const mergeEnv = (
  sourced: Readonly<Record<string, Sourced>>,
  pristine: Readonly<Record<string, Sourced>>,
  owned: Readonly<Record<string, Owned>>
): ReadonlyArray<EnvVar> =>
  [...new Set([...Object.keys(sourced), ...Object.keys(owned)])].sort().map((key) => {
    const fromSource = sourced[key]
    const mine = owned[key]
    const sensitive = (fromSource?.sensitive ?? false) || looksSensitive(key)
    const value = mine?.value ?? fromSource?.value ?? ""
    const before = pristine[key]?.value
    const replaced = before !== undefined && before !== value ? { replaced: sensitive ? redact(before) : before } : {}
    if (mine) return { key, value, sensitive, source: mine.source, ...replaced }
    const warning = warningFor(key, value)
    return { key, value, sensitive, source: fromSource?.source ?? "?", ...replaced, ...(warning ? { warning } : {}) }
  })

const shown = (vars: ReadonlyArray<EnvVar>): ReadonlyArray<EnvVar> =>
  vars.map((entry) => (entry.sensitive ? { ...entry, value: redact(entry.value) } : entry))

export class Supervisor extends Context.Service<Supervisor, {
  readonly run: (stack: Stack, worktree: Worktree) => Effect.Effect<never, unknown, Scope.Scope>
  readonly envOf: (worktree: string, service: string) => Effect.Effect<ReadonlyArray<EnvVar> | undefined>
  readonly restart: (worktree: string, service: string) => Effect.Effect<void>
}>()("forkyard/Supervisor") {
  static readonly layer = (options: { readonly startupConcurrency: number; readonly otlpUrl: string }) =>
    Layer.effect(
      Supervisor,
      Effect.gen(function*() {
        const infra = yield* InfraManager
        const proc = yield* Proc
        const ports = yield* Ports
        const router = yield* Router
        const status = yield* Status
        const fs = yield* FileSystem.FileSystem
        const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
        const startup = yield* Semaphore.make(options.startupConcurrency)
        const resolved = yield* Ref.make<Readonly<Record<string, ReadonlyArray<EnvVar>>>>({})
        const restarts = yield* PubSub.unbounded<string>()
        const pristineCache = yield* Ref.make<Readonly<Record<string, Readonly<Record<string, Sourced>>>>>({})

        const waitHealthy = (port: number, path: string) =>
          http.get(`http://127.0.0.1:${port}${path}`).pipe(
            Effect.retry(Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: "60 seconds" }))),
            Effect.asVoid
          )

        const readFile = (path: string) =>
          fs.exists(path).pipe(
            Effect.flatMap((present) => (present ? fs.readFileString(path).pipe(Effect.map(Option.some)) : Effect.succeedNone)),
            Effect.mapError((error) => new EnvError({ source: path, message: error.message }))
          )

        const restartRequested = Effect.fnUntraced(function*(key: string) {
          const subscription = yield* PubSub.subscribe(restarts)
          return PubSub.take(subscription).pipe(Effect.repeat({ until: (requested) => requested === key }), Effect.asVoid)
        })

        const run = Effect.fn("Supervisor.run")(function*(stack: Stack, worktree: Worktree) {
          const worktreeAttributes = { "forkyard.worktree": worktree.id, "forkyard.project": worktree.project, "forkyard.branch": worktree.branch }
          yield* Effect.annotateCurrentSpan({ ...worktreeAttributes, "forkyard.root": worktree.root })
          const nodes = yield* stack.build(worktree)
          yield* Effect.annotateCurrentSpan({ "forkyard.nodes": nodes.length })
          yield* plan(nodes)
          const ready = Object.fromEntries(
            yield* Effect.forEach(nodes, (node) =>
              Deferred.make<Readonly<Record<string, Owned>>>().pipe(Effect.map((deferred) => [nodeName(node), deferred] as const))
            )
          )
          const deferredOf = (name: string) => ready[name]!

          yield* Effect.forEach(
            nodes.filter(isInfra),
            (node) =>
              Effect.gen(function*() {
                const name = node.spec.name
                yield* status.update(worktree.id, name, { kind: "infra", state: "starting", shared: node.spec.scope === "shared" })
                const began = yield* Clock.currentTimeMillis
                const lease = yield* infra.acquire(node.spec, worktree)
                const took = (yield* Clock.currentTimeMillis) - began
                yield* Metric.update(Metric.withAttributes(Metrics.infraStart, { "forkyard.infra": name, "forkyard.infra.scope": node.spec.scope }), took)
                const url = Object.values(lease.server.urls)[0]
                const detail = node.spec.scope === "shared" ? `shared server, ${lease.server.instance}` : "this worktree only"
                yield* status.update(worktree.id, name, { kind: "infra", state: "ready", detail, ...(url ? { url } : {}) })
                const owned = Object.fromEntries(Object.entries(lease.env).map(([key, value]) => [key, { value, source: `infra:${name}` }]))
                yield* Deferred.succeed(deferredOf(name), owned)
              }).pipe(
                Effect.tapError((error) => status.update(worktree.id, node.spec.name, { kind: "infra", state: "failed", detail: String(error) })),
                Effect.withSpan("Supervisor.acquireInfra", { attributes: { ...worktreeAttributes, "forkyard.infra": node.spec.name, "forkyard.infra.scope": node.spec.scope } }),
                Effect.forkScoped
              ),
            { discard: true }
          )

          const sourcesFor = Effect.fn("Supervisor.sourcesFor")(function*(service: ServiceNode, owned: Readonly<Record<string, Owned>>) {
            yield* Effect.annotateCurrentSpan({ ...worktreeAttributes, "forkyard.service": service.name, "forkyard.env.sources": service.envFrom.map((source) => source.label).join(", "), "forkyard.env.with_overrides": Object.keys(owned).length > 0 })
            const cwd = `${worktree.root}/${service.cwd}`
            const overrides: Env = Object.fromEntries(
              Object.entries(owned).filter(([key]) => visibleToSources(key)).map(([key, entry]) => [key, entry.value])
            )
            const context: EnvLoadContext = {
              root: worktree.root,
              cwd,
              overrides,
              readFile,
              exec: (run, dir) =>
                proc.exec({ worktree: worktree.id, service: `${service.name}:env`, run, env: overrides, cwd: dir }).pipe(
                  Effect.mapError((error) => new EnvError({ source: service.name, message: error.message }))
                )
            }
            const loaded = yield* Effect.forEach(service.envFrom, (source) =>
              source.load(context).pipe(
                Effect.map((entries) => Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { ...entry, source: source.label }]))),
                Effect.tap((entries) => Effect.annotateCurrentSpan({ "forkyard.env.keys": Object.keys(entries).length })),
                Effect.withSpan("EnvSource.load", { attributes: { "forkyard.env.source": source.label, "forkyard.service": service.name } })
              )
            )
            return loaded.reduce<Readonly<Record<string, Sourced>>>((all, next) => ({ ...all, ...next }), {})
          }, Effect.scoped)

          const pristineFor = Effect.fn("Supervisor.pristineFor")(function*(service: ServiceNode) {
            const key = envKey(worktree.id, service.name)
            const cached = (yield* Ref.get(pristineCache))[key]
            if (cached) return cached
            const loaded = yield* sourcesFor(service, {})
            yield* Ref.update(pristineCache, (all) => ({ ...all, [key]: loaded }))
            return loaded
          })

          const otelResource = [
            `service.namespace=${worktree.id}`,
            `forkyard.worktree=${worktree.id}`,
            `forkyard.project=${worktree.project}`,
            `forkyard.branch=${worktree.branch}`
          ].join(",")

          const resolveEnv = Effect.fn("Supervisor.resolveEnv")(function*(service: ServiceNode, base: Readonly<Record<string, Owned>>, port: number | undefined) {
            yield* Effect.annotateCurrentSpan({ ...worktreeAttributes, "forkyard.service": service.name })
            const began = yield* Clock.currentTimeMillis
            const daemon: Readonly<Record<string, Owned>> = {
              FORKYARD_WORKTREE: { value: worktree.id, source: "forkyard" },
              FORKYARD_BRANCH: { value: worktree.branch, source: "forkyard" },
              FORKYARD_SERVICE: { value: service.name, source: "forkyard" },
              OTEL_EXPORTER_OTLP_ENDPOINT: { value: options.otlpUrl, source: "forkyard:otel" },
              OTEL_SERVICE_NAME: { value: service.name, source: "forkyard:otel" },
              OTEL_RESOURCE_ATTRIBUTES: { value: otelResource, source: "forkyard:otel" },
              ...(port ? { PORT: { value: String(port), source: "forkyard" } } : {})
            }
            const owned = { ...base, ...daemon }
            const [sourced, pristine] = yield* Effect.all([sourcesFor(service, owned), pristineFor(service)], { concurrency: 2 })
            const vars = mergeEnv(sourced, pristine, owned)
            yield* Ref.update(resolved, (all) => ({ ...all, [envKey(worktree.id, service.name)]: shown(vars) }))
            const took = (yield* Clock.currentTimeMillis) - began
            yield* Metric.update(Metric.withAttributes(Metrics.envResolve, { "forkyard.service": service.name }), took)
            yield* Effect.annotateCurrentSpan({
              "forkyard.env.keys": vars.length,
              "forkyard.env.replaced": vars.filter((entry) => entry.replaced !== undefined).length,
              "forkyard.env.flagged": vars.filter((entry) => entry.warning !== undefined).map((entry) => entry.key).join(", ")
            })
            return Object.fromEntries(vars.map((entry) => [entry.key, entry.value])) as Env
          })

          const telemetry = { namespace: worktree.id, attributes: { "forkyard.worktree": worktree.id, "forkyard.project": worktree.project, "forkyard.branch": worktree.branch } }

          const spawnWith = (service: ServiceNode, env: Env) =>
            proc.spawn({ worktree: worktree.id, service: service.name, run: service.run, env, cwd: `${worktree.root}/${service.cwd}`, telemetry })

          const runTask = Effect.fn("Supervisor.runTask", { root: true })(function*(service: ServiceNode, base: Readonly<Record<string, Owned>>) {
            yield* Effect.annotateCurrentSpan({ ...worktreeAttributes, "forkyard.service": service.name, "forkyard.kind": service.kind })
            yield* status.update(worktree.id, service.name, { kind: "task", state: "starting" })
            const env = yield* resolveEnv(service, base, undefined)
            const code = yield* startup.withPermit(
              spawnWith(service, env).pipe(
                Effect.tap((spawned) => status.update(worktree.id, service.name, { kind: "task", state: "starting", pid: spawned.pid, runId: spawned.runId, run: spawned.run })),
                Effect.flatMap((spawned) => spawned.exited),
                Effect.scoped
              )
            )
            yield* Effect.annotateCurrentSpan({ "process.exit_code": code })
            if (code !== 0) {
              yield* status.update(worktree.id, service.name, { kind: "task", state: "failed", detail: `exit ${code}` })
              return yield* new TaskFailed({ service: service.name, exitCode: code })
            }
            yield* status.update(worktree.id, service.name, { kind: "task", state: "done" })
            yield* Deferred.succeed(deferredOf(service.name), {})
          })

          const start = Effect.fn("Supervisor.start")(function*(service: ServiceNode, base: Readonly<Record<string, Owned>>) {
            const port = service.kind === "http" ? yield* ports.allocate : undefined
            const env = yield* resolveEnv(service, base, port)
            const began = yield* Clock.currentTimeMillis
            const spawned = yield* spawnWith(service, env)
            yield* Effect.annotateCurrentSpan({ "forkyard.run": spawned.run, "process.pid": spawned.pid, ...(port ? { "server.port": port, "url.full": urlOf(worktree, service.name) } : {}) })
            yield* status.update(worktree.id, service.name, { kind: service.kind, state: "starting", pid: spawned.pid, runId: spawned.runId, run: spawned.run })
            if (!port) return spawned
            yield* router.expose({ host: hostOf(worktree, service.name), port })
            yield* waitHealthy(port, service.health ?? "/health").pipe(
              Effect.raceFirst(spawned.exited),
              Effect.withSpan("Supervisor.waitHealthy", { attributes: { "forkyard.service": service.name, "server.port": port, "url.path": service.health ?? "/health" } })
            )
            const took = (yield* Clock.currentTimeMillis) - began
            yield* Metric.update(Metric.withAttributes(Metrics.serviceReady, { "forkyard.service": service.name, "forkyard.project": worktree.project }), took)
            return spawned
          })

          const runOnce = Effect.fn("Supervisor.runOnce", { root: true })(function*(service: ServiceNode, base: Readonly<Record<string, Owned>>) {
            yield* Effect.annotateCurrentSpan({ ...worktreeAttributes, "forkyard.service": service.name, "forkyard.kind": service.kind })
            const key = envKey(worktree.id, service.name)
            const restartWanted = yield* restartRequested(key)
            const spawned = yield* startup.withPermit(start(service, base))
            yield* Deferred.succeed(deferredOf(service.name), {})
            yield* status.update(worktree.id, service.name, { kind: service.kind, state: "ready" })
            const outcome = yield* Effect.raceFirst(
              spawned.exited.pipe(Effect.map((code) => `exited with ${code}`)),
              restartWanted.pipe(Effect.as("restart requested"))
            )
            yield* status.update(worktree.id, service.name, { kind: service.kind, state: "crashed", detail: outcome })
            yield* Effect.annotateCurrentSpan({ "forkyard.outcome": outcome })
            yield* Metric.update(Metric.withAttributes(Metrics.restarts, { "forkyard.service": service.name, "forkyard.reason": outcome.startsWith("restart") ? "requested" : "exited" }), 1)
            yield* Effect.logWarning(`${worktree.id}/${service.name} ${outcome}, restarting`)
          }, Effect.scoped)

          const supervise = Effect.fn("Supervisor.supervise")(function*(service: ServiceNode) {
            yield* Effect.annotateCurrentSpan({ ...worktreeAttributes, "forkyard.service": service.name })
            const url = service.kind === "http" ? { url: urlOf(worktree, service.name) } : {}
            yield* status.update(worktree.id, service.name, { kind: service.kind, state: "waiting", ...url })
            const infraEnvs = yield* Effect.forEach(service.uses, (name) => Deferred.await(deferredOf(name)))
            yield* Effect.forEach(service.after, (name) => Deferred.await(deferredOf(name)), { discard: true })
            const config = Object.fromEntries(Object.entries(service.env).map(([key, value]) => [key, { value, source: "forkyard.config" }]))
            const base = [...infraEnvs, config].reduce<Readonly<Record<string, Owned>>>((all, next) => ({ ...all, ...next }), {})
            if (service.kind === "task") return yield* runTask(service, base)
            return yield* runOnce(service, base).pipe(
              Effect.catchCause((cause) =>
                status.update(worktree.id, service.name, { kind: service.kind, state: "crashed", detail: String(cause).slice(0, 300) })
              ),
              Effect.repeat(Schedule.spaced("1 second")),
              Effect.andThen(Effect.never)
            )
          })

          yield* Effect.forEach(nodes.filter(isService), (service) => Effect.forkScoped(supervise(service)), {
            discard: true
          })
          const forget = <A>(all: Readonly<Record<string, A>>) =>
            Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith(`${worktree.id}/`)))
          yield* Effect.addFinalizer(() => Ref.update(resolved, forget).pipe(Effect.andThen(Ref.update(pristineCache, forget))))
          return yield* Effect.never
        })

        return Supervisor.of({
          run,
          envOf: (worktree, service) => Ref.get(resolved).pipe(Effect.map((all) => all[envKey(worktree, service)])),
          restart: (worktree, service) => PubSub.publish(restarts, envKey(worktree, service)).pipe(Effect.asVoid)
        })
      })
    )
}
