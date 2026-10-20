import { Effect, Schema } from "effect"
import { type InputsContext, InputsError, type InputsHook, type InputsTarget } from "../Inputs.ts"
import { lockCache, type LockCache, lockOf, sliceHash } from "./Lockfile.ts"

const Dependency = Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })])

const Project = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  config: Schema.optional(Schema.Struct({ dependsOn: Schema.optional(Schema.Array(Dependency)) }))
})

const Projects = Schema.Struct({ projects: Schema.Array(Project) })

type Project = typeof Project.Type

type Graph = Readonly<Record<string, Project>>

export type MoonOptions = {
  readonly services: Readonly<Record<string, string>>
  readonly paths?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly always?: ReadonlyArray<string>
  readonly lockfile?: string | false
}

const idOf = (dependency: typeof Dependency.Type) => (typeof dependency === "string" ? dependency : dependency.id)

const dependenciesOf = (project: Project) => (project.config?.dependsOn ?? []).map(idOf)

const closure = (graph: Graph, ids: ReadonlyArray<string>, seen: ReadonlySet<string> = new Set()): ReadonlySet<string> => {
  const fresh = ids.filter((id) => !seen.has(id) && graph[id])
  if (fresh.length === 0) return seen
  const next = new Set([...seen, ...fresh])
  return closure(
    graph,
    fresh.flatMap((id) => dependenciesOf(graph[id]!)),
    next
  )
}

const graphOf = Effect.fnUntraced(function* (context: InputsContext) {
  const json = yield* context.exec({ command: "moon", args: ["query", "projects"] })
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Projects))(json).pipe(
    Effect.mapError((error) => new InputsError({ message: `moon query projects: ${error.message}` }))
  )
  return Object.fromEntries(decoded.projects.map((project) => [project.id, project])) as Graph
})

const unknownProject = (target: InputsTarget, project: string) =>
  new InputsError({ message: `${target.name} maps to moon project "${project}", which moon does not know` })

const lockSlice = Effect.fnUntraced(function* (
  cache: LockCache,
  file: string | false,
  context: InputsContext,
  sources: ReadonlyArray<string>
) {
  if (!file) return []
  const contentHash = context.fileHash(file)
  if (!contentHash) return []
  const lock = yield* lockOf(cache, context.root, file, contentHash)
  return [`lockfile ${sliceHash(lock, [".", ...sources])}`]
})

export const moon = (options: MoonOptions): Effect.Effect<InputsHook> => lockCache.pipe(Effect.map((cache) => hookWith(options, cache)))

const hookWith = (options: MoonOptions, cache: LockCache): InputsHook => {
  const lockfile = options.lockfile ?? "pnpm-lock.yaml"
  return (target, context) =>
    Effect.gen(function* () {
      const always = target.kind === "service" ? (options.always ?? []) : []
      const explicit = options.paths?.[target.name]
      if (explicit) return { paths: [...explicit, ...always] }

      const project = options.services[target.name]
      if (!project) return undefined

      const graph = yield* graphOf(context)
      if (!graph[project]) return yield* unknownProject(target, project)
      const sources = [...closure(graph, [project])].map((id) => graph[id]!.source)
      const extra = target.kind === "service" ? yield* lockSlice(cache, lockfile, context, sources) : []
      return { paths: [...sources, ...always], extra }
    })
}
