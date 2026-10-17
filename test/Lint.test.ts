import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const lintFixtures = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("pnpm", ["run", "--silent", "lint:fixtures"]))
})

describe("forkyard lint rules", () => {
  it.effect(
    "each rule reports the fixture that breaks it",
    () =>
      Effect.gen(function* () {
        const output = yield* lintFixtures.pipe(Effect.orElseSucceed(() => ""))
        const rules = ["scoped-processes", "no-gen-wrapper", "flat-orchestration", "edges-only", "branded-ids"]

        expect(rules.filter((rule) => !output.includes(`forkyard(${rule})`))).toEqual([])
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000
  )
})
