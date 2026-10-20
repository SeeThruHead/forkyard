import { Effect, Schema } from "effect"
import { type InputsContext, InputsError, type InputsHook, type InputsTarget } from "../Inputs.ts"

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

export const moon =
  (options: MoonOptions): InputsHook =>
  (target, context) =>
    Effect.gen(function* () {
      const always = target.kind === "service" ? (options.always ?? []) : []
      const explicit = options.paths?.[target.name]
      if (explicit) return { paths: [...explicit, ...always] }

      const project = options.services[target.name]
      if (!project) return undefined

      const graph = yield* graphOf(context)
      if (!graph[project]) return yield* unknownProject(target, project)
      const sources = [...closure(graph, [project])].map((id) => graph[id]!.source)
      return { paths: [...sources, ...always] }
    })
