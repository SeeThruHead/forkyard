import { describe, expect, it } from "@effect/vitest"
import { BranchSlug, ProjectName } from "../src/Ids.ts"
import { firstFreeName } from "../src/Registry.ts"

const project = ProjectName.make("taskboard")
const main = BranchSlug.make("main")

describe("worktree names", () => {
  it("uses the branch when nobody else has it", () => {
    expect(firstFreeName(main, project, new Set())).toBe("main")
  })

  it("adds -2, -3 when other folders already use the name", () => {
    expect(firstFreeName(main, project, new Set(["main.taskboard"]))).toBe("main-2")
    expect(firstFreeName(main, project, new Set(["main.taskboard", "main-2.taskboard"]))).toBe("main-3")
  })

  it("only collides within the same repo", () => {
    expect(firstFreeName(main, project, new Set(["main.storefront"]))).toBe("main")
  })
})

describe("hosts file block", () => {
  it("adds, replaces and removes forkyard's block without touching other lines", async () => {
    const { withHostsBlock } = await import("../src/Router.ts")
    const base = "127.0.0.1 localhost\n"
    const once = withHostsBlock(base, ["api.main.app.localhost"])
    expect(once).toContain("127.0.0.1 api.main.app.localhost")
    const twice = withHostsBlock(once, ["web.main.app.localhost"])
    expect(twice).not.toContain("api.main.app.localhost")
    expect(twice.startsWith("127.0.0.1 localhost")).toBe(true)
    expect(withHostsBlock(twice, [])).toBe(base)
  })
})
