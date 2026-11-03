import { Clock, Context, Effect, FiberSet, FileSystem, Layer, Metric, Ref } from "effect"
import { EnvError, type EnvEntry, type EnvLoadContext, type EnvSource, looksSensitive } from "./EnvSource.ts"
import { ownerOfWorktree, type Port, type ServiceName, type WorktreeId } from "./Ids.ts"
import * as Metrics from "./Metrics.ts"
import type { EnvVar } from "./Model.ts"
import { Proc } from "./Proc.ts"
import type { Env, ServiceNode, Worktree } from "./Stack.ts"

export type Owned = { readonly value: string; readonly source: string }

export type OwnedEnv = Readonly<Record<string, Owned>>

type Sourced = EnvEntry & { readonly source: string }

type SourcedEnv = Readonly<Record<string, Sourced>>

const fixedPort = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/

const redact = (value: string) => (value.length <= 4 ? "****" : `${value.slice(0, 2)}****${value.slice(-2)}`)

const warningFor = (key: string, value: string) =>
  fixedPort.test(value) ? `${key} points at a fixed port. Map it in forkyard.config.ts so each worktree gets its own.` : undefined

const visibleToSources = (key: string) => !key.startsWith("OTEL_") && key !== "NODE_OPTIONS" && key !== "PATH"

const keyOf = (id: WorktreeId, service: ServiceName) => `${id}/${service}`

export const owned = (source: string, env: Env): OwnedEnv =>
  Object.fromEntries(Object.entries(env).map(([key, value]) => [key, { value, source }]))

const repoBins = (worktree: Worktree, cwd: string, basePath: string) =>
  [`${worktree.root}/${cwd}/node_modules/.bin`, `${worktree.root}/node_modules/.bin`, basePath]
    .filter((entry) => entry.length > 0)
    .join(":")

export type DaemonContext = { readonly otlpUrl: string | undefined; readonly otlpHeaders: string; readonly basePath: string }

const telemetrySource = "forkyard:otel"

export const daemonEnv = (
  worktree: Worktree,
  service: { readonly name: ServiceName; readonly cwd: string },
  port: Port | undefined,
  { basePath }: DaemonContext
): OwnedEnv =>
  owned("forkyard", {
    PATH: repoBins(worktree, service.cwd, basePath),
    FORKYARD_WORKTREE: worktree.id,
    FORKYARD_BRANCH: worktree.branch,
    FORKYARD_SERVICE: service.name,
    ...(port ? { PORT: String(port) } : {})
  })

export const telemetryDefaults = (
  worktree: Worktree,
  service: { readonly name: ServiceName },
  { otlpUrl, otlpHeaders }: DaemonContext
): OwnedEnv => ({
  ...(otlpUrl
    ? owned(telemetrySource, {
        OTEL_EXPORTER_OTLP_ENDPOINT: otlpUrl,
        ...(otlpHeaders ? { OTEL_EXPORTER_OTLP_HEADERS: otlpHeaders } : {}),
        OTEL_SERVICE_NAME: service.name,
        OTEL_RESOURCE_ATTRIBUTES: `service.namespace=${worktree.id},forkyard.worktree=${worktree.id},forkyard.project=${worktree.project},forkyard.branch=${worktree.branch}`
      })
    : {})
})

const winningOwned = (mine: Owned | undefined, fromSource: Sourced | undefined) => {
  if (!mine) return undefined
  if (mine.source === telemetrySource && fromSource) return undefined
  return mine
}

export const mergeEnv = (sourced: SourcedEnv, pristine: SourcedEnv, ownedEnv: OwnedEnv): ReadonlyArray<EnvVar> =>
  [...new Set([...Object.keys(sourced), ...Object.keys(ownedEnv)])].sort().map((key) => {
    const fromSource = sourced[key]
    const mine = winningOwned(ownedEnv[key], fromSource)
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

const valuesOf = (vars: ReadonlyArray<EnvVar>): Env => Object.fromEntries(vars.map((entry) => [entry.key, entry.value]))

const merged = (loaded: ReadonlyArray<SourcedEnv>) => loaded.reduce<SourcedEnv>((all, next) => ({ ...all, ...next }), {})

const labelled =
  (source: EnvSource) =>
  (entries: Readonly<Record<string, EnvEntry>>): SourcedEnv =>
    Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { ...entry, source: source.label }]))

export class EnvResolver extends Context.Service<
  EnvResolver,
  {
    readonly resolve: (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv) => Effect.Effect<Env, EnvError>
    readonly report: (id: WorktreeId, service: ServiceName) => Effect.Effect<ReadonlyArray<EnvVar> | undefined>
    readonly forget: (id: WorktreeId) => Effect.Effect<void>
  }
>()("forkyard/Env") {
  static readonly layer = Layer.effect(
    EnvResolver,
    Effect.gen(function* () {
      const proc = yield* Proc
      const fs = yield* FileSystem.FileSystem
      const reports = yield* Ref.make<Readonly<Record<string, ReadonlyArray<EnvVar>>>>({})
      const pristineCache = yield* Ref.make<Readonly<Record<string, SourcedEnv>>>({})
      const background = yield* FiberSet.make()

      const readFile = (path: string) =>
        fs.exists(path).pipe(
          Effect.flatMap((present) => (present ? fs.readFileString(path).pipe(Effect.asSome) : Effect.succeedNone)),
          Effect.mapError((error) => new EnvError({ source: path, message: error.message }))
        )

      const loadContext = (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv): EnvLoadContext => {
        const overrides: Env = Object.fromEntries(
          Object.entries(ownedEnv)
            .filter(([key]) => visibleToSources(key))
            .map(([key, entry]) => [key, entry.value])
        )
        const exec: EnvLoadContext["exec"] = (run, cwd) =>
          proc
            .exec({ owner: ownerOfWorktree(worktree.id), service: `${service.name}:env`, run, env: overrides, cwd })
            .pipe(Effect.mapError((error) => new EnvError({ source: service.name, message: error.message })))

        return { root: worktree.root, cwd: `${worktree.root}/${service.cwd}`, overrides, readFile, exec }
      }

      const loadSource = (context: EnvLoadContext, service: ServiceNode) => (source: EnvSource) =>
        source
          .load(context)
          .pipe(
            Effect.map(labelled(source)),
            Effect.withSpan("EnvSource.load", { attributes: { "forkyard.env.source": source.label, "forkyard.service": service.name } })
          )

      const loadSources = Effect.fn("Env.loadSources")(function* (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv) {
        const context = loadContext(worktree, service, ownedEnv)
        const loaded = yield* Effect.forEach(service.envFrom, loadSource(context, service))

        return merged(loaded)
      }, Effect.scoped)

      const pristine = Effect.fn("Env.pristine")(function* (worktree: Worktree, service: ServiceNode) {
        const key = keyOf(worktree.id, service.name)
        const cached = (yield* Ref.get(pristineCache))[key]
        if (cached) return cached

        const loaded = yield* loadSources(worktree, service, {})
        yield* Ref.update(pristineCache, (all) => ({ ...all, [key]: loaded }))

        return loaded
      })

      const recordTiming = (service: ServiceNode, since: number) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Metric.update(Metric.withAttributes(Metrics.envResolve, { "forkyard.service": service.name }), now - since)
          )
        )

      const record = (worktree: Worktree, service: ServiceNode, vars: ReadonlyArray<EnvVar>) =>
        Ref.update(reports, (all) => ({ ...all, [keyOf(worktree.id, service.name)]: shown(vars) }))

      const reportWithOriginals = (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv, sourced: SourcedEnv) =>
        pristine(worktree, service).pipe(Effect.flatMap((before) => record(worktree, service, mergeEnv(sourced, before, ownedEnv))))

      const resolve = Effect.fn("Env.resolve")(function* (worktree: Worktree, service: ServiceNode, ownedEnv: OwnedEnv) {
        yield* Effect.annotateCurrentSpan({ "forkyard.worktree": worktree.id, "forkyard.service": service.name })
        const began = yield* Clock.currentTimeMillis

        const sourced = yield* loadSources(worktree, service, ownedEnv)
        const vars = mergeEnv(sourced, {}, ownedEnv)
        yield* record(worktree, service, vars)
        yield* FiberSet.run(background, reportWithOriginals(worktree, service, ownedEnv, sourced))

        yield* recordTiming(service, began)
        return valuesOf(vars)
      })

      const forget = (id: WorktreeId) => {
        const keep = <A>(all: Readonly<Record<string, A>>) =>
          Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith(`${id}/`)))
        return Ref.update(reports, keep).pipe(Effect.andThen(Ref.update(pristineCache, keep)))
      }

      return EnvResolver.of({
        resolve,
        report: (id, service) => Ref.get(reports).pipe(Effect.map((all) => all[keyOf(id, service)])),
        forget
      })
    })
  )
}
