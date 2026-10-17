import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { AbsolutePath, BranchSlug, Port, ProjectName, WorktreeId } from "../src/Ids.ts"
import { bun, CurrentWorktree, logLine, type Node, node, Service, StackBuilder, tsNode, watch, type Worktree } from "../src/Stack.ts"

const worktree: Worktree = {
  id: WorktreeId.make("main.app"),
  project: ProjectName.make("app"),
  branch: BranchSlug.make("main"),
  root: AbsolutePath.make("/repo"),
  domain: "main.app.localhost",
  proxyPort: Port.make(80)
}

const declared = Effect.fnUntraced(function* <A, E>(program: Effect.Effect<A, E, StackBuilder | CurrentWorktree>) {
  const nodes = yield* Ref.make<ReadonlyArray<Node>>([])
  const builder = StackBuilder.of({ add: (node) => Ref.update(nodes, (all) => [...all, node]) })

  yield* program.pipe(Effect.provideService(StackBuilder, builder), Effect.provideService(CurrentWorktree, worktree))
  return yield* Ref.get(nodes)
})

describe("process model", () => {
  it.effect("presets set exposure and lifecycle", () =>
    Effect.gen(function* () {
      const nodes = yield* declared(
        Effect.all([
          Service.http("api", { run: "pnpm run dev" }),
          Service.worker("jobs", { run: "pnpm run worker", ready: logLine(/listening/) }),
          Service.task("migrate", { run: "pnpm run db:migrate", watch: watch("db/migrations/**") })
        ])
      )
      const shapes = nodes.map((node) => (node._tag === "Service" ? [node.name, node.exposure._tag, node.lifecycle._tag] : []))

      expect(shapes).toEqual([
        ["api", "Routed", "LongRunning"],
        ["jobs", "Internal", "LongRunning"],
        ["migrate", "Internal", "RunOnce"]
      ])
    })
  )

  it.effect("a command string runs through the shell exactly as written", () =>
    Effect.gen(function* () {
      const [node] = yield* declared(Service.task("seed", { run: "./scripts/seed.sh --fresh" }))

      expect(node?._tag === "Service" ? node.run : undefined).toEqual({ command: "/bin/sh", args: ["-c", "./scripts/seed.sh --fresh"] })
    })
  )

  it.effect("rejects combinations that cannot work", () =>
    Effect.gen(function* () {
      const healthWithoutRoute = yield* Effect.flip(declared(Service.process("api", { run: "x", ready: "healthy" })))
      const routedTask = yield* Effect.flip(declared(Service.process("migrate", { run: "x", ready: "exited", route: true })))
      const restartingTask = yield* Effect.flip(declared(Service.process("migrate", { run: "x", ready: "exited", onExit: "restart" })))

      expect([healthWithoutRoute, routedTask, restartingTask].map((error) => error._tag)).toEqual([
        "ConfigError",
        "ConfigError",
        "ConfigError"
      ])
    })
  )

  it("run helpers build the command a repo would type", () => {
    expect(node("src/server.ts", { args: ["--port", "0"] })).toEqual({ command: "node", args: ["src/server.ts", "--port", "0"] })
    expect(bun("worker.ts", { watch: true })).toEqual({ command: "bun", args: ["--watch", "worker.ts"] })
    expect(tsNode("src/server.ts", { require: ["tsconfig-paths/register"] })).toEqual({
      command: "ts-node",
      args: ["--transpile-only", "-r", "tsconfig-paths/register", "src/server.ts"]
    })
  })
})
