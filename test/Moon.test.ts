import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { moon } from "../src/inputs/Moon.ts"

const level = (i: number) => [
  { id: `n${i}`, source: `n${i}`, config: { dependsOn: [`a${i}`, `b${i}`] } },
  { id: `a${i}`, source: `a${i}`, config: { dependsOn: [`n${i + 1}`] } },
  { id: `b${i}`, source: `b${i}`, config: { dependsOn: [`n${i + 1}`] } }
]

const depth = 40

const diamonds = { projects: [...Array.from({ length: depth }, (_, i) => level(i)).flat(), { id: `n${depth}`, source: `n${depth}` }] }

describe("moon inputs", () => {
  it.effect("expands each project once, even when many paths reach it", () =>
    Effect.gen(function* () {
      const inputs = yield* moon({ services: { api: "n0" } })(
        { name: "api", kind: "service" },
        { root: "/repo", exec: () => Effect.succeed(JSON.stringify(diamonds)) }
      )

      expect(inputs?.paths.length).toBe(depth * 3 + 1)
    }).pipe(Effect.scoped)
  )
})
