import { Array, Effect, Graph, Option, Schema } from "effect"
import type { Node } from "./Stack.ts"

export class PlanError extends Schema.TaggedError<PlanError, { readonly brand: unique symbol }>()("PlanError", {
  message: Schema.String
}) {}

export const nodeName = (node: Node): string => (node._tag === "Service" ? node.name : node.spec.name)

const dependencies = (node: Node): ReadonlyArray<string> => (node._tag === "Service" ? [...node.uses, ...node.after] : [])

export type Plan = {
  readonly graph: Graph.DirectedGraph<string, "needs">
  readonly order: ReadonlyArray<string>
  readonly mermaid: string
}

const calls = (node: Node): ReadonlyArray<string> => (node._tag === "Service" ? node.calls : [])

const unknownDependencies = (nodes: ReadonlyArray<Node>) => {
  const names = nodes.map(nodeName)
  return nodes.flatMap((node) => [
    ...dependencies(node)
      .filter((dep) => !names.includes(dep))
      .map((dep) => `${nodeName(node)} needs ${dep}`),
    ...calls(node)
      .filter((callee) => !names.includes(callee))
      .map((callee) => `${nodeName(node)} calls ${callee}`)
  ])
}

const dependencyGraph = (nodes: ReadonlyArray<Node>) =>
  Graph.directed<string, "needs">((mutable) => {
    const index = new Map(nodes.map((node) => [nodeName(node), Graph.addNode(mutable, nodeName(node))] as const))
    nodes.forEach((node) =>
      dependencies(node).forEach((dep) => Graph.addEdge(mutable, index.get(dep)!, index.get(nodeName(node))!, "needs"))
    )
  })

const cyclePath = (graph: Graph.DirectedGraph<string, "needs">) =>
  Graph.findCycle(graph).pipe(
    Option.map((cycle) => cycle.path.map((index) => Graph.getNode(graph, index).pipe(Option.getOrElse(() => "?"))))
  )

export const plan = Effect.fn("Plan.plan")(function* (nodes: ReadonlyArray<Node>) {
  const missing = unknownDependencies(nodes)
  if (Array.isReadonlyArrayNonEmpty(missing)) return yield* new PlanError({ message: `Unknown dependencies: ${missing.join(", ")}` })

  const graph = dependencyGraph(nodes)
  const cycle = cyclePath(graph)
  if (Option.isSome(cycle)) return yield* new PlanError({ message: `Dependency cycle: ${cycle.value.join(" -> ")}` })

  return {
    graph,
    order: [...Graph.values(Graph.topo(graph))],
    mermaid: Graph.toMermaid(graph, { nodeLabel: (name) => name, edgeLabel: () => "" })
  } satisfies Plan
})
