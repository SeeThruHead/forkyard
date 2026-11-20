import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { defineStack } from "../src/Define.ts"
import { AbsolutePath, BranchSlug, Port, ProjectName, WorktreeId } from "../src/Ids.ts"
import { watch, type Node, type Worktree } from "../src/Stack.ts"

const worktree: Worktree = {
  id: WorktreeId.make("main.app"),
  project: ProjectName.make("app"),
  branch: BranchSlug.make("main"),
  root: AbsolutePath.make("/repo"),
  profile: "default",
  domain: "main.app.localhost",
  proxyPort: Port.make(80)
}

const watchedGlobs = (node: Node) => (node._tag === "Service" ? [node.name, node.lifecycle.watch?.globs] : [])

describe("defineStack", () => {
  it.effect("keeps watch on every kind of service", () =>
    Effect.gen(function* () {
      const stack = defineStack({
        name: "app",
        infra: {},
        services: {
          migrate: { kind: "task", run: "node migrate.mjs", watch: watch("db/**") },
          api: { kind: "http", run: "node api.mjs", after: ["migrate"], watch: watch("api/**") },
          jobs: { kind: "worker", run: "node jobs.mjs", watch: watch("jobs/**") }
        }
      })
      const nodes = yield* stack.build(worktree)

      expect(nodes.map(watchedGlobs)).toEqual([
        ["migrate", ["db/**"]],
        ["api", ["api/**"]],
        ["jobs", ["jobs/**"]]
      ])
    })
  )
})
