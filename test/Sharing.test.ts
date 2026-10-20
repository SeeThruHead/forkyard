import { describe, expect, it } from "@effect/vitest"
import { codeHash } from "../src/Inputs.ts"
import { referencesOf, withCalls } from "../src/Sharing.ts"
import type { Worktree } from "../src/Stack.ts"

const worktree = { domain: "feat.shop.localhost" } as Worktree

describe("sharing", () => {
  const own = { api: "a", graph: "c", app: "p", admin: "d" }
  const calls = { app: ["api", "graph"], api: ["graph"] }

  it("two worktrees with the same code get the same fingerprints", () => {
    expect(withCalls(own, calls)).toEqual(withCalls({ ...own }, calls))
  })

  it("changing a service changes the fingerprint of everything that calls it, and nothing else", () => {
    const before = withCalls(own, calls)
    const after = withCalls({ ...own, graph: "changed" }, calls)
    expect(after.graph).not.toEqual(before.graph)
    expect(after.api).not.toEqual(before.api)
    expect(after.app).not.toEqual(before.app)
    expect(after.admin).toEqual(before.admin)
  })

  it("a service that calls something without a fingerprint has none either", () => {
    const fingerprints = withCalls({ api: "a", app: "p" }, { app: ["api"], api: ["fake-auth"] })
    expect(fingerprints).toEqual({})
  })

  it("services that call each other in a cycle still get stable fingerprints", () => {
    const cyclic = { login: ["ui"], ui: ["login"] }
    expect(withCalls({ login: "l", ui: "u" }, cyclic)).toEqual(withCalls({ login: "l", ui: "u" }, cyclic))
    expect(withCalls({ login: "l", ui: "u2" }, cyclic).login).not.toEqual(withCalls({ login: "l", ui: "u" }, cyclic).login)
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
