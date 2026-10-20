import { describe, expect, it } from "@effect/vitest"
import { InfraName, ServiceName } from "../src/Ids.ts"
import { demandedNames, localNames } from "../src/Placement.ts"
import type { ServiceNode } from "../src/Stack.ts"

type Shape = {
  readonly after?: ReadonlyArray<string>
  readonly calls?: ReadonlyArray<string>
  readonly uses?: ReadonlyArray<string>
  readonly consumes?: ReadonlyArray<string>
  readonly task?: boolean
}

const node = (name: string, shape: Shape = {}): ServiceNode => ({
  _tag: "Service",
  name: ServiceName.make(name),
  run: { shell: name },
  cwd: ".",
  env: {},
  envFrom: [],
  uses: [...(shape.uses ?? []), ...(shape.consumes ?? [])].map((infra) => InfraName.make(infra)),
  consumes: (shape.consumes ?? []).map((infra) => InfraName.make(infra)),
  after: (shape.after ?? []).map((dependency) => ServiceName.make(dependency)),
  calls: (shape.calls ?? []).map((callee) => ServiceName.make(callee)),
  ports: [],
  exposure: { _tag: "Internal" },
  lifecycle: shape.task
    ? { _tag: "RunOnce", watch: undefined }
    : { _tag: "LongRunning", ready: { _tag: "Started" }, onExit: "restart", watch: undefined }
})

const shop = [
  node("install", { task: true }),
  node("migrate", { task: true, after: ["install"], uses: ["postgres"] }),
  node("codegen", { task: true, after: ["install", "graph"] }),
  node("api", { after: ["install", "migrate"], uses: ["postgres", "nats"] }),
  node("graph", { after: ["install", "migrate"], uses: ["postgres"], calls: ["api"] }),
  node("admin", { after: ["install", "api", "graph", "codegen"], calls: ["api", "graph"] }),
  node("payments", { after: ["install"], calls: ["api"], consumes: ["nats"] }),
  node("handlers", { after: ["install"], uses: ["postgres"], consumes: ["nats"] })
]

const sorted = (names: ReadonlySet<string>) => [...names].sort()

describe("placement", () => {
  it("a frontend change runs only the frontend and the tasks that prepare its folder", () => {
    expect(sorted(localNames(shop, new Set(["admin"])))).toEqual(["admin", "codegen", "install"])
  })

  it("a backend change also runs everything that calls it, and consumers it brings along get their own queue", () => {
    expect(sorted(localNames(shop, new Set(["api"])))).toEqual([
      "admin",
      "api",
      "codegen",
      "graph",
      "handlers",
      "install",
      "nats",
      "payments"
    ])
  })

  it("a migration gives the worktree its own database, and everything using it runs here, migrate included", () => {
    const local = localNames(shop, new Set(["postgres"]))
    expect(sorted(local)).toEqual(["admin", "api", "codegen", "graph", "handlers", "install", "migrate", "nats", "payments", "postgres"])
  })

  it("a consumer that runs here gets its own copy of what it consumes, so it never takes shared messages", () => {
    const local = localNames(shop, new Set(["handlers"]))
    expect(local.has("nats")).toBe(true)
    expect(local.has("api")).toBe(true)
    expect(local.has("postgres")).toBe(false)
  })

  it("tasks that touch shared infra stay shared, even when something here needs them", () => {
    expect(localNames(shop, new Set(["api"])).has("migrate")).toBe(false)
  })

  it("starting a service starts what it waits on, and nothing else", () => {
    expect(sorted(demandedNames(shop, new Set(["admin"])))).toEqual(["admin", "api", "codegen", "graph", "install", "migrate"])
  })
})
