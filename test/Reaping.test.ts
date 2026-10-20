import { describe, expect, it } from "@effect/vitest"
import { reapable, type Usage } from "../src/infra/Reaping.ts"

const day = 24 * 60 * 60 * 1000
const now = 100 * day
const grace = 7 * day

const used = (tenant: string, root: string, daysAgo: number): Usage => ({ tenant, root, lastUsed: now - daysAgo * day })

describe("tenant reaping", () => {
  it("drops old tenants nobody uses, and keeps each existing worktree's latest one", () => {
    const usages = [
      used("shared-aaaa.shop", "/code/shop", 30),
      used("shared-bbbb.shop", "/code/shop", 20),
      used("shared-cccc.shop", "/wt/gone", 10),
      used("shared-dddd.shop", "/wt/gone", 1)
    ]
    expect(reapable(usages, new Set(), new Set(["/code/shop"]), now, grace)).toEqual(["shared-aaaa.shop", "shared-cccc.shop"])
  })

  it("a tenant counts as used when any worktree used it recently", () => {
    const usages = [used("shared-aaaa.shop", "/wt/gone", 30), used("shared-aaaa.shop", "/wt/other-gone", 2)]
    expect(reapable(usages, new Set(), new Set(), now, grace)).toEqual([])
  })

  it("never drops a tenant that is leased right now", () => {
    expect(reapable([used("shared-aaaa.shop", "/wt/gone", 30)], new Set(["shared-aaaa.shop"]), new Set(), now, grace)).toEqual([])
  })
})
