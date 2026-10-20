import { Cache, Context, Effect, FileSystem, Layer, Path, Ref } from "effect"
import { createHash } from "node:crypto"
import { ownerOfWorktree, type WorktreeId } from "./Ids.ts"
import {
  codeHash,
  combine,
  envHash,
  fileHashIn,
  InputsError,
  hookOf,
  type InputsSource,
  type InputsTarget,
  type Snapshot,
  snapshotOf
} from "./Inputs.ts"
import { Proc } from "./Proc.ts"
import { hostOf, type InfraNode, type Run, type ServiceNode, type Worktree } from "./Stack.ts"

const forkyardKeys = ["PATH", "PORT", "FORKYARD_WORKTREE", "FORKYARD_BRANCH", "FORKYARD_SERVICE", "OTEL_RESOURCE_ATTRIBUTES"]

const hostPattern = (host: string) => new RegExp(`(?<![a-z0-9-])${host.replaceAll(".", "\\.")}`)

export type Reference = { readonly key: string; readonly service: string }

export const referencesIn = (
  env: Readonly<Record<string, string>>,
  worktree: Worktree,
  names: ReadonlyArray<string>
): ReadonlyArray<Reference> =>
  names.flatMap((name) => {
    const pattern = hostPattern(hostOf(worktree, name))
    return Object.entries(env)
      .filter(([, value]) => pattern.test(value))
      .map(([key]) => ({ key, service: name }))
  })

export const referencesOf = (env: Readonly<Record<string, string>>, worktree: Worktree, names: ReadonlyArray<string>) => [
  ...new Set(referencesIn(env, worktree, names).map((reference) => reference.service))
]

export const undeclared = (service: ServiceNode, references: ReadonlyArray<Reference>) =>
  references.filter(
    (reference) => !service.links.includes(reference.key) && !service.calls.includes(reference.service as ServiceNode["name"])
  )

type Fingerprints = Readonly<Record<string, string>>

const unknownCallees = (fingerprints: Fingerprints, calls: Readonly<Record<string, ReadonlyArray<string>>>) =>
  Object.keys(fingerprints).filter((name) => (calls[name] ?? []).some((callee) => fingerprints[callee] === undefined))

const withoutUnknownCallees = (fingerprints: Fingerprints, calls: Readonly<Record<string, ReadonlyArray<string>>>): Fingerprints => {
  const unknown = unknownCallees(fingerprints, calls)
  if (unknown.length === 0) return fingerprints
  return withoutUnknownCallees(Object.fromEntries(Object.entries(fingerprints).filter(([name]) => !unknown.includes(name))), calls)
}

export const withCalls = (own: Fingerprints, calls: Readonly<Record<string, ReadonlyArray<string>>>): Fingerprints => {
  const known = withoutUnknownCallees(own, calls)
  const step = (current: Fingerprints): Fingerprints =>
    Object.fromEntries(
      Object.entries(known).map(([name, fingerprint]) => [
        name,
        combine(fingerprint, ...(calls[name] ?? []).map((callee) => current[callee] ?? "").sort())
      ])
    )
  return Array.from({ length: Object.keys(known).length }).reduce<Fingerprints>((current) => step(current), known)
}

const isTask = (service: ServiceNode) => service.lifecycle._tag === "RunOnce"

const tasksNeededHere = (services: ReadonlyArray<ServiceNode>, shared: ReadonlySet<string>) =>
  services
    .filter((service) => !shared.has(service.name))
    .flatMap((service) => service.after)
    .filter((name) => shared.has(name) && services.some((service) => service.name === name && isTask(service)))

export const sharedTasksAllowed = (services: ReadonlyArray<ServiceNode>, shared: ReadonlySet<string>): ReadonlySet<string> => {
  const needed = tasksNeededHere(services, shared)
  if (needed.length === 0) return shared
  return sharedTasksAllowed(services, new Set([...shared].filter((name) => !needed.some((task) => task === name))))
}

const runText = (run: Run) => ("shell" in run ? run.shell : [run.command, ...run.args].join(" "))

const serviceFingerprint = (
  worktree: Worktree,
  domains: ReadonlyArray<string>,
  service: ServiceNode,
  hash: string,
  env: Readonly<Record<string, string>>,
  infra: Readonly<Record<string, string>>
) => {
  const ignored = [...forkyardKeys, ...service.ports]
  const normalized = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replaceAll(worktree.root, "@root")]))
  const usedInfra = service.uses.map((name) => infra[name] ?? "").sort()
  return combine(hash, runText(service.run), service.cwd, service.lifecycle._tag, envHash(normalized, domains, ignored), ...usedInfra)
}

export type ServiceFingerprints = {
  readonly fingerprints: Readonly<Record<string, string>>
  readonly unexplained: ReadonlyArray<string>
}

export type Session = {
  readonly infra: (
    infra: ReadonlyArray<InfraNode>,
    services: ReadonlyArray<ServiceNode>
  ) => Effect.Effect<Readonly<Record<string, string>>, InputsError>
  readonly services: (options: {
    readonly services: ReadonlyArray<ServiceNode>
    readonly infra: Readonly<Record<string, string>>
    readonly envOf: (service: ServiceNode) => Effect.Effect<Readonly<Record<string, string>>, unknown>
  }) => Effect.Effect<ServiceFingerprints, unknown>
  readonly refresh: Effect.Effect<Refreshed, unknown>
}

export type Refreshed = {
  readonly infra: Readonly<Record<string, string>>
  readonly services: Readonly<Record<string, string>>
}

type Measured = {
  readonly resolved: ReadonlyArray<{ readonly service: ServiceNode; readonly env: Readonly<Record<string, string>> }>
  readonly references: Readonly<Record<string, ReadonlyArray<string>>>
  readonly infra: Readonly<Record<string, string>>
  readonly infraNodes: ReadonlyArray<InfraNode>
  readonly consumers: ReadonlyArray<ServiceNode>
}

export class Sharing extends Context.Service<
  Sharing,
  { readonly session: (source: InputsSource, worktree: Worktree) => Effect.Effect<Session, InputsError> }
>()("forkyard/Sharing") {
  static readonly layer = Layer.effect(
    Sharing,
    Effect.gen(function* () {
      const proc = yield* Proc
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const execIn = (id: WorktreeId, root: string) => (run: Run) =>
        proc
          .exec({ owner: ownerOfWorktree(id), service: "fingerprint", run, env: {}, cwd: root })
          .pipe(Effect.mapError((error) => new InputsError({ message: error.message })))

      const contentHash = (root: string) => (file: string) =>
        fs.readFile(path.join(root, file)).pipe(
          Effect.map((bytes) => createHash("sha256").update(bytes).digest("hex")),
          Effect.orElseSucceed(() => "deleted")
        )

      const session = Effect.fn("Sharing.session")(function* (source: InputsSource, worktree: Worktree) {
        const hook = yield* hookOf(source)
        const exec = execIn(worktree.id, worktree.root)
        const cache = yield* Cache.make({ lookup: (key: string) => exec(JSON.parse(key) as Run).pipe(Effect.scoped), capacity: 64 })
        const cachedExec = (run: Run) => Cache.get(cache, JSON.stringify(run))
        const takeSnapshot = snapshotOf({ exec, contentHash: contentHash(worktree.root) }).pipe(Effect.scoped)
        const codeWith = (snapshot: Snapshot) => (target: InputsTarget) =>
          hook(target, { root: worktree.root, exec: cachedExec, fileHash: fileHashIn(snapshot) }).pipe(
            Effect.map((inputs) => (inputs ? codeHash(snapshot, inputs) : undefined)),
            Effect.scoped
          )
        const measured = yield* Ref.make<Measured | undefined>(undefined)

        const consumerHashes = (snapshot: Snapshot, node: InfraNode, consumers: ReadonlyArray<ServiceNode>) =>
          Effect.forEach(
            consumers.filter((service) => service.consumes.includes(node.spec.name)).toSorted((a, b) => a.name.localeCompare(b.name)),
            (service) =>
              codeWith(snapshot)({ name: service.name, kind: "service" }).pipe(Effect.map((hash) => `${service.name}:${hash ?? "none"}`))
          )

        const infraFrom = (snapshot: Snapshot, nodes: ReadonlyArray<InfraNode>, consumers: ReadonlyArray<ServiceNode>) =>
          Effect.forEach(nodes, (node) =>
            Effect.all([codeWith(snapshot)({ name: node.spec.name, kind: "infra" }), consumerHashes(snapshot, node, consumers)]).pipe(
              Effect.map(([hash, consumed]) => [node.spec.name, combine(node.spec.name, hash ?? "default", ...consumed)] as const)
            )
          ).pipe(Effect.map((entries): Readonly<Record<string, string>> => Object.fromEntries(entries)))

        const infraNodes = yield* Ref.make<ReadonlyArray<InfraNode>>([])
        const consumers = yield* Ref.make<ReadonlyArray<ServiceNode>>([])

        const infra = (nodes: ReadonlyArray<InfraNode>, services: ReadonlyArray<ServiceNode>) =>
          Ref.set(infraNodes, nodes).pipe(
            Effect.andThen(Ref.set(consumers, services)),
            Effect.andThen(takeSnapshot),
            Effect.flatMap((snapshot) => infraFrom(snapshot, nodes, services))
          )

        const fingerprintsFrom = Effect.fnUntraced(function* (snapshot: Snapshot, state: Measured) {
          const hashes = yield* Effect.forEach(state.resolved, ({ service, env }) =>
            codeWith(snapshot)({ name: service.name, kind: "service" }).pipe(Effect.map((hash) => ({ service, env, hash })))
          )
          const own = Object.fromEntries(
            hashes.flatMap(({ service, env, hash }) =>
              hash === undefined
                ? []
                : [[service.name, serviceFingerprint(worktree, [worktree.domain], service, hash, env, state.infra)] as const]
            )
          )
          return withCalls(own, state.references)
        })

        const services: Session["services"] = Effect.fnUntraced(function* (options) {
          const names = options.services.map((service) => service.name)
          const resolved = yield* Effect.forEach(
            options.services,
            (service) => options.envOf(service).pipe(Effect.map((env) => ({ service, env }))),
            { concurrency: 4 }
          )
          const found = Object.fromEntries(
            resolved.map(({ service, env }) => [
              service.name,
              undeclared(
                service,
                referencesIn(
                  env,
                  worktree,
                  names.filter((name) => name !== service.name)
                )
              )
            ])
          )
          const references = Object.fromEntries(
            options.services.map((service) => [
              service.name,
              [...new Set([...service.calls, ...(found[service.name] ?? []).map((reference) => reference.service)])]
            ])
          )
          const unexplained = Object.entries(found).flatMap(([name, list]) =>
            list.map((reference) => `${name}.${reference.key} -> ${reference.service}`)
          )
          const state = {
            resolved,
            references,
            infra: options.infra,
            infraNodes: yield* Ref.get(infraNodes),
            consumers: yield* Ref.get(consumers)
          } satisfies Measured
          yield* Ref.set(measured, state)
          return { fingerprints: yield* fingerprintsFrom(yield* takeSnapshot, state), unexplained } satisfies ServiceFingerprints
        })

        const refresh = Effect.fnUntraced(function* () {
          const state = yield* Ref.get(measured)
          if (!state) return { infra: {}, services: {} } satisfies Refreshed
          const snapshot = yield* takeSnapshot
          const infra = yield* infraFrom(snapshot, state.infraNodes, state.consumers)
          return { infra, services: yield* fingerprintsFrom(snapshot, { ...state, infra }) } satisfies Refreshed
        })()

        return { infra, services, refresh } satisfies Session
      })

      return Sharing.of({ session })
    })
  )
}
