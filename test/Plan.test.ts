import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { plan } from "../src/Plan.ts"
import { ServiceName } from "../src/Ids.ts"
import type { Node, ServiceNode } from "../src/Stack.ts"

const service = (name: string, after: ReadonlyArray<string> = []): ServiceNode => ({
  _tag: "Service",
  name: ServiceName.make(name),
  run: { command: "node", args: [] },
  cwd: ".",
  env: {},
  envFrom: [],
  uses: [],
  after: after.map((dependency) => ServiceName.make(dependency)),
  ports: [],
  consumes: [],
  calls: [],
  exposure: { _tag: "Internal" },
  lifecycle: { _tag: "LongRunning", ready: { _tag: "Started" }, onExit: "restart", watch: undefined }
})

describe("Plan", () => {
  it.effect("orders services after their dependencies", () =>
    Effect.gen(function* () {
      const nodes: ReadonlyArray<Node> = [service("admin", ["api"]), service("api", ["migrate"]), service("migrate")]
      const result = yield* plan(nodes)
      expect(result.order).toEqual(["migrate", "api", "admin"])
    })
  )

  it.effect("rejects a dependency cycle with its path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(plan([service("api", ["admin"]), service("admin", ["api"])]))
      expect(error._tag).toBe("PlanError")
      expect(error.message).toContain("Dependency cycle")
    })
  )

  it.effect("rejects a dependency that is not declared", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(plan([service("api", ["migrat"])]))
      expect(error.message).toBe("Unknown dependencies: api needs migrat")
    })
  )
})
