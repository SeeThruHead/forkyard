import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { BranchSlug, branchSlug, databaseName, Port, ProjectName, ServiceName, worktreeId } from "../src/Ids.ts"

describe("ids", () => {
  it("only accepts names that are safe in a hostname", () => {
    expect(Option.isSome(ServiceName.makeOption("api"))).toBe(true)
    expect(Option.isNone(ServiceName.makeOption("API"))).toBe(true)
    expect(Option.isNone(ServiceName.makeOption("my_service"))).toBe(true)
    expect(Option.isNone(ServiceName.makeOption("-api"))).toBe(true)
  })

  it("turns any branch into a slug, or nothing", () => {
    expect(branchSlug("feature/Gift Cards!")).toEqual(Option.some(BranchSlug.make("feature-gift-cards")))
    expect(branchSlug("///")).toEqual(Option.none())
  })

  it("builds worktree ids only from valid parts", () => {
    expect(worktreeId(BranchSlug.make("main"), ProjectName.make("storefront"))).toBe("main.storefront")
  })

  it("makes database names Postgres accepts", () => {
    expect(databaseName("storefront", "feat-gift-cards")).toBe("storefront_feat_gift_cards")
    expect(databaseName("2024", "x")).toBe("_2024_x")
  })

  it("rejects ports outside 1 to 65535", () => {
    expect(Option.isNone(Port.makeOption(0))).toBe(true)
    expect(Option.isNone(Port.makeOption(70000))).toBe(true)
    expect(Option.isSome(Port.makeOption(8080))).toBe(true)
  })
})
