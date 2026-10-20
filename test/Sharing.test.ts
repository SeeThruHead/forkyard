import { describe, expect, it } from "@effect/vitest"
import { codeHash } from "../src/Inputs.ts"
import { InfraName, ServiceName } from "../src/Ids.ts"
import { referencesOf, shareableInfra, shareableServices } from "../src/Sharing.ts"
import type { InfraNode, ServiceNode, Worktree } from "../src/Stack.ts"

const service = (name: string, after: ReadonlyArray<string> = [], uses: ReadonlyArray<string> = []): ServiceNode => ({
  _tag: "Service",
  name: ServiceName.make(name),
  run: { shell: name },
  cwd: ".",
  env: {},
  envFrom: [],
  uses: uses.map((used) => InfraName.make(used)),
  after: after.map((dependency) => ServiceName.make(dependency)),
  ports: [],
  exposure: { _tag: "Routed", health: "/health" },
  lifecycle: { _tag: "LongRunning", ready: { _tag: "Healthy" }, onExit: "restart", watch: undefined }
})

const infra = (name: string) => ({ _tag: "Infra", spec: { name: InfraName.make(name) } }) as unknown as InfraNode

const worktree = { domain: "feat.shop.localhost" } as Worktree

describe("sharing", () => {
  const services = [service("api", [], ["postgres"]), service("graph", [], ["postgres"]), service("app", ["api"]), service("admin")]
  const same = { api: "a", graph: "c", app: "p", admin: "d" }

  it("shares every service whose fingerprint and infra match the base", () => {
    const shared = shareableServices({ services, infra: new Set(["postgres"]), mine: same, base: same, references: {} })
    expect([...shared].sort()).toEqual(["admin", "api", "app", "graph"])
  })

  it("a changed service runs its own copy, and so does everything that calls it", () => {
    const shared = shareableServices({
      services,
      infra: new Set(["postgres"]),
      mine: { ...same, graph: "changed" },
      base: same,
      references: { api: ["graph"], app: ["api"] }
    })
    expect([...shared].sort()).toEqual(["admin"])
  })

  it("a service on infra the worktree does not share runs its own copy", () => {
    const shared = shareableServices({ services, infra: new Set(), mine: same, base: same, references: {} })
    expect([...shared].sort()).toEqual(["admin", "app"])
  })

  it("a service without a fingerprint is never shared", () => {
    const shared = shareableServices({ services, infra: new Set(["postgres"]), mine: { api: "a" }, base: same, references: {} })
    expect([...shared]).toEqual(["api"])
  })

  it("infra is shared when its fingerprint matches", () => {
    expect([...shareableInfra([infra("postgres"), infra("redis")], { postgres: "1", redis: "2" }, { postgres: "1", redis: "3" })]).toEqual([
      "postgres"
    ])
  })

  it("finds references to other services by hostname, not by substring", () => {
    const env = { CORE: "http://api.feat.shop.localhost", PAY: "http://payments-api.feat.shop.localhost/graphql" }
    expect(referencesOf(env, worktree, ["api", "payments-api", "graph"])).toEqual(["api", "payments-api"])
    expect(referencesOf({ PAY: env.PAY }, worktree, ["api"])).toEqual([])
  })

  it("hashes the files under a service's paths, with uncommitted edits replacing the committed version", () => {
    const snapshot = {
      tracked: new Map([
        ["api/src/a.ts", "1"],
        ["apps/admin/b.ts", "2"]
      ]),
      changed: new Map<string, string>()
    }
    const edited = { ...snapshot, changed: new Map([["apps/admin/b.ts", "3"]]) }
    expect(codeHash(snapshot, { paths: ["api"] })).toEqual(codeHash(edited, { paths: ["api"] }))
    expect(codeHash(snapshot, { paths: ["apps/admin"] })).not.toEqual(codeHash(edited, { paths: ["apps/admin"] }))
  })
})
