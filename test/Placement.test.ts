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
  uses: ["telemetry", ...(shape.uses ?? []), ...(shape.consumes ?? [])].map((infra) => InfraName.make(infra)),
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

const common = new Set(["telemetry"])

const place = (...changed: ReadonlyArray<string>) => [...localNames(shop, new Set(changed), common)].sort()

describe("placement", () => {
  it("a frontend change runs only the frontend and the tasks that prepare its folder", () => {
    expect(place("admin")).toEqual(["admin", "codegen", "install"])
  })

  it("a backend change also runs everything that calls it, and consumers it brings along get their own queue", () => {
    expect(place("api")).toEqual(["admin", "api", "codegen", "graph", "handlers", "install", "nats", "payments"])
  })

  it("a migration gives the worktree its own database, and everything using it runs here, migrate included", () => {
    expect(place("postgres")).toEqual([
      "admin",
      "api",
      "codegen",
      "graph",
      "handlers",
      "install",
      "migrate",
      "nats",
      "payments",
      "postgres"
    ])
  })

  it("a consumer that runs here gets its own copy of what it consumes, so it never takes shared messages", () => {
    expect(place("handlers")).toContain("nats")
    expect(place("handlers")).toContain("api")
    expect(place("handlers")).not.toContain("postgres")
  })

  it("tasks that touch shared infra stay shared, even when something here needs them", () => {
    expect(place("api")).not.toContain("migrate")
  })

  it("infra every worktree uses as-is, like telemetry, never decides where something runs", () => {
    expect(place("telemetry")).toEqual([])
    expect([...localNames(shop, new Set(["admin"]))]).not.toContain("install")
  })

  it("starting a service starts what it waits on, and nothing else", () => {
    expect([...demandedNames(shop, new Set(["admin"]))].sort()).toEqual(["admin", "api", "codegen", "graph", "install", "migrate"])
  })
})
