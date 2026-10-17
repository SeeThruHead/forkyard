import { describe, expect, it } from "@effect/vitest"
import { targetOf } from "../src/Watch.ts"

describe("watch targets", () => {
  it("watches only the fixed folder a glob starts with", () => {
    expect(targetOf("packages/db/migrations/**")).toEqual({ directory: "packages/db/migrations", recursive: true })
    expect(targetOf("src/**/*.sql")).toEqual({ directory: "src", recursive: true })
    expect(targetOf("**/*.sql")).toEqual({ directory: ".", recursive: true })
  })

  it("watches a single file's folder without recursing", () => {
    expect(targetOf("apps/api/migrate.ts")).toEqual({ directory: "apps/api", recursive: false })
    expect(targetOf("schema.sql")).toEqual({ directory: ".", recursive: false })
  })
})
