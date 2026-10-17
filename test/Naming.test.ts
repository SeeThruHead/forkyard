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
