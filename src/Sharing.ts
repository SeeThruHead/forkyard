import { Cache, Context, Effect, FileSystem, Layer, Path } from "effect"
import { createHash } from "node:crypto"
import { ownerOfWorktree, type WorktreeId } from "./Ids.ts"
import { codeHash, combine, envHash, InputsError, type InputsHook, type InputsTarget, snapshotOf } from "./Inputs.ts"
import { Proc } from "./Proc.ts"
import { hostOf, type InfraNode, type Run, type ServiceNode, type Worktree } from "./Stack.ts"

const forkyardKeys = ["PATH", "PORT", "FORKYARD_WORKTREE", "FORKYARD_BRANCH", "FORKYARD_SERVICE", "OTEL_RESOURCE_ATTRIBUTES"]

const hostPattern = (host: string) => new RegExp(`(?<![a-z0-9-])${host.replaceAll(".", "\\.")}`)

export const referencesOf = (env: Readonly<Record<string, string>>, worktree: Worktree, names: ReadonlyArray<string>) => {
  const values = Object.values(env)
  return names.filter((name) => {
    const pattern = hostPattern(hostOf(worktree, name))
    return values.some((value) => pattern.test(value))
  })
}

const usesOwnInfra = (service: ServiceNode, infra: ReadonlySet<string>) => service.uses.some((name) => !infra.has(name))

const dependsOnOwn = (dependencies: ReadonlyArray<string>, own: ReadonlySet<string>) => dependencies.some((name) => own.has(name))

const grow = (
  services: ReadonlyArray<ServiceNode>,
  dependencies: Readonly<Record<string, ReadonlyArray<string>>>,
  own: ReadonlySet<string>
): ReadonlySet<string> => {
  const more = services.filter((service) => !own.has(service.name) && dependsOnOwn(dependencies[service.name] ?? [], own))
  if (more.length === 0) return own
  return grow(services, dependencies, new Set([...own, ...more.map((service) => service.name)]))
}

export const shareableInfra = (
  infra: ReadonlyArray<InfraNode>,
  mine: Readonly<Record<string, string>>,
  base: Readonly<Record<string, string>>
) => new Set(infra.map((node) => node.spec.name).filter((name) => mine[name] !== undefined && mine[name] === base[name]))

export const shareableServices = (options: {
  readonly services: ReadonlyArray<ServiceNode>
  readonly infra: ReadonlySet<string>
  readonly mine: Readonly<Record<string, string>>
  readonly base: Readonly<Record<string, string>>
  readonly references: Readonly<Record<string, ReadonlyArray<string>>>
}): ReadonlySet<string> => {
  const matches = (name: string) => options.mine[name] !== undefined && options.mine[name] === options.base[name]
  const direct = options.services.filter((service) => !matches(service.name) || usesOwnInfra(service, options.infra))
  const dependencies = Object.fromEntries(options.services.map((service) => [service.name, options.references[service.name] ?? []]))
  const own = grow(options.services, dependencies, new Set(direct.map((service) => service.name)))
  return new Set(options.services.map((service) => service.name).filter((name) => !own.has(name)))
}

const runText = (run: Run) => ("shell" in run ? run.shell : [run.command, ...run.args].join(" "))

const serviceFingerprint = (
  worktree: Worktree,
  service: ServiceNode,
  hash: string,
  env: Readonly<Record<string, string>>,
  infra: Readonly<Record<string, string>>
) => {
  const ignored = [...forkyardKeys, ...service.ports]
  const normalized = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replaceAll(worktree.root, "@root")]))
  const usedInfra = service.uses.map((name) => infra[name] ?? "").sort()
  return combine(
    hash,
    runText(service.run),
    service.cwd,
    service.lifecycle._tag,
    envHash(normalized, worktree.domain, ignored),
    ...usedInfra
  )
}

export type ServiceFingerprints = {
  readonly fingerprints: Readonly<Record<string, string>>
  readonly references: Readonly<Record<string, ReadonlyArray<string>>>
}

export type Session = {
  readonly infra: (infra: ReadonlyArray<InfraNode>) => Effect.Effect<Readonly<Record<string, string>>, InputsError>
  readonly services: (options: {
    readonly services: ReadonlyArray<ServiceNode>
    readonly infra: Readonly<Record<string, string>>
    readonly envOf: (service: ServiceNode) => Effect.Effect<Readonly<Record<string, string>>, unknown>
  }) => Effect.Effect<ServiceFingerprints, unknown>
}

export class Sharing extends Context.Service<
  Sharing,
  { readonly session: (hook: InputsHook, worktree: Worktree) => Effect.Effect<Session, InputsError> }
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

      const session = Effect.fn("Sharing.session")(function* (hook: InputsHook, worktree: Worktree) {
        const exec = execIn(worktree.id, worktree.root)
        const cache = yield* Cache.make({ lookup: (key: string) => exec(JSON.parse(key) as Run).pipe(Effect.scoped), capacity: 64 })
        const cachedExec = (run: Run) => Cache.get(cache, JSON.stringify(run))
        const snapshot = yield* snapshotOf({ exec: cachedExec, contentHash: contentHash(worktree.root) }).pipe(Effect.scoped)
        const code = (target: InputsTarget) =>
          hook(target, { root: worktree.root, exec: cachedExec }).pipe(
            Effect.map((inputs) => (inputs ? codeHash(snapshot, inputs) : undefined)),
            Effect.scoped
          )

        const infra = (nodes: ReadonlyArray<InfraNode>) =>
          Effect.forEach(nodes, (node) =>
            code({ name: node.spec.name, kind: "infra" }).pipe(
              Effect.map((hash) => [node.spec.name, combine(node.spec.name, hash ?? "default")] as const)
            )
          ).pipe(Effect.map((entries): Readonly<Record<string, string>> => Object.fromEntries(entries)))

        const services: Session["services"] = Effect.fnUntraced(function* (options) {
          const names = options.services.map((service) => service.name)
          const resolved = yield* Effect.forEach(
            options.services,
            (service) =>
              Effect.all([code({ name: service.name, kind: "service" }), options.envOf(service)]).pipe(
                Effect.map(([hash, env]) => ({ service, hash, env }))
              ),
            { concurrency: 4 }
          )
          const fingerprints = Object.fromEntries(
            resolved.flatMap(({ service, hash, env }) =>
              hash === undefined ? [] : [[service.name, serviceFingerprint(worktree, service, hash, env, options.infra)] as const]
            )
          )
          const references = Object.fromEntries(resolved.map(({ service, env }) => [service.name, referencesOf(env, worktree, names)]))
          return { fingerprints, references } satisfies ServiceFingerprints
        })

        return { infra, services } satisfies Session
      })

      return Sharing.of({ session })
    })
  )
}
