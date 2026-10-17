import { Array, Effect, Graph, Option, Schema } from "effect"
import type { Node } from "./Stack.ts"

export class PlanError extends Schema.TaggedError<PlanError>()("PlanError", {
  message: Schema.String
}) {}

export const nodeName = (node: Node): string => (node._tag === "Service" ? node.name : node.spec.name)

const dependencies = (node: Node): ReadonlyArray<string> =>
  node._tag === "Service" ? [...node.uses, ...node.after] : []

export type Plan = {
  readonly graph: Graph.DirectedGraph<string, "needs">
  readonly order: ReadonlyArray<string>
  readonly mermaid: string
}

export const plan = Effect.fn("Plan.plan")(function*(nodes: ReadonlyArray<Node>) {
  const names = nodes.map(nodeName)
  const missing = nodes.flatMap((node) =>
    dependencies(node).filter((dep) => !names.includes(dep)).map((dep) => `${nodeName(node)} needs ${dep}`)
  )
  if (Array.isReadonlyArrayNonEmpty(missing)) {
    return yield* new PlanError({ message: `Unknown dependencies: ${missing.join(", ")}` })
  }

  const graph = Graph.directed<string, "needs">((mutable) => {
    const index = new Map(names.map((name) => [name, Graph.addNode(mutable, name)] as const))
    nodes.forEach((node) =>
      dependencies(node).forEach((dep) => Graph.addEdge(mutable, index.get(dep)!, index.get(nodeName(node))!, "needs"))
    )
  })

  const cycle = Graph.findCycle(graph)
  if (Option.isSome(cycle)) {
    const path = cycle.value.path.map((index) => Graph.getNode(graph, index).pipe(Option.getOrElse(() => "?")))
    return yield* new PlanError({ message: `Dependency cycle: ${path.join(" -> ")}` })
  }

  return {
    graph,
    order: [...Graph.values(Graph.topo(graph))],
    mermaid: Graph.toMermaid(graph, { nodeLabel: (name) => name, edgeLabel: () => "" })
  } satisfies Plan
})
