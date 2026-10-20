import { Cache, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "yaml"
import { InputsError } from "../Inputs.ts"

const Resolved = Schema.Struct({ specifier: Schema.String, version: Schema.String })

const ResolvedMap = Schema.Record(Schema.String, Resolved)

const Importer = Schema.Struct({
  dependencies: Schema.optional(ResolvedMap),
  devDependencies: Schema.optional(ResolvedMap),
  optionalDependencies: Schema.optional(ResolvedMap)
})

const Versions = Schema.Record(Schema.String, Schema.String)

const Snapshot = Schema.NullOr(
  Schema.Struct({
    dependencies: Schema.optional(Versions),
    optionalDependencies: Schema.optional(Versions)
  })
)

const Lock = Schema.Struct({
  importers: Schema.Record(Schema.String, Importer),
  snapshots: Schema.optional(Schema.Record(Schema.String, Snapshot))
})

export type Lock = typeof Lock.Type

type Importer = typeof Importer.Type

const decodeLock = Schema.decodeUnknownEffect(Lock)

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const failure = (file: string) => (error: unknown) =>
  new InputsError({ message: `${file}: ${error instanceof Error ? error.message : String(error)}` })

const load = (key: string) => {
  const [root = "", file = ""] = JSON.parse(key) as ReadonlyArray<string>
  const path = join(root, file)
  return Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: failure(path) }).pipe(
    Effect.flatMap((text) => Effect.try({ try: () => parse(text) as unknown, catch: failure(path) })),
    Effect.flatMap((raw) => decodeLock(raw).pipe(Effect.mapError(failure(path))))
  )
}

export const lockCache = Cache.make({ lookup: load, capacity: 4 })

export type LockCache = Effect.Success<typeof lockCache>

export const lockOf = (cache: LockCache, root: string, file: string, contentHash: string) =>
  Cache.get(cache, JSON.stringify([root, file, contentHash]))

const resolvedOf = (importer: Importer) => [
  ...Object.entries(importer.dependencies ?? {}),
  ...Object.entries(importer.devDependencies ?? {}),
  ...Object.entries(importer.optionalDependencies ?? {})
]

const isWorkspace = (version: string) => version.startsWith("link:") || version.startsWith("workspace:")

const childrenOf = (lock: Lock, key: string) => {
  const snapshot = lock.snapshots?.[key]
  if (!snapshot) return []
  return [...Object.entries(snapshot.dependencies ?? {}), ...Object.entries(snapshot.optionalDependencies ?? {})].map(
    ([name, version]) => `${name}@${version}`
  )
}

const reachable = (lock: Lock, keys: ReadonlyArray<string>, seen: ReadonlySet<string> = new Set()): ReadonlySet<string> => {
  const fresh = [...new Set(keys.filter((key) => !seen.has(key)))]
  if (fresh.length === 0) return seen
  return reachable(
    lock,
    fresh.flatMap((key) => childrenOf(lock, key)),
    new Set([...seen, ...fresh])
  )
}

export const sliceHash = (lock: Lock, importerPaths: ReadonlyArray<string>) => {
  const importers = importerPaths.flatMap((path) => {
    const importer = lock.importers[path]
    return importer ? [[path, importer] as const] : []
  })
  const direct = importers.flatMap(([path, importer]) => resolvedOf(importer).map(([name, resolved]) => ({ path, name, ...resolved })))
  const packages = reachable(
    lock,
    direct.filter((entry) => !isWorkspace(entry.version)).map((entry) => `${entry.name}@${entry.version}`)
  )
  return sha256(
    [
      ...direct
        .map((entry) => `${entry.path} ${entry.name} ${entry.specifier} ${isWorkspace(entry.version) ? "workspace" : entry.version}`)
        .sort(),
      ...[...packages].sort()
    ].join("\n")
  )
}
