import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"

const rules = {
  spawner: { pattern: /from "effect\/process"|NodeChildProcessSpawner|child_process/, reason: "only Proc may spawn" },
  platform: { pattern: /NodeServices/, reason: "NodeServices carries the spawner, use Platform.layer" },
  unscopedFork: { pattern: /\b(forkDetach|forkDaemon|forkIn|runFork|runPromise|runSync|runCallback)\b/, reason: "work outside a scope" },
  signal: { pattern: /\bprocess\.kill\(/, reason: "signals belong to Proc's scope or the Registry reaper" }
}

type Rule = keyof typeof rules

const exemptions: Readonly<Record<string, ReadonlyArray<Rule>>> = {
  "src/Proc.ts": ["spawner"],
  "src/Registry.ts": ["signal"]
}

const roots = ["src", "examples"]

const isChecked = (file: string) => {
  if (file.includes("node_modules")) return false
  if (file.startsWith("examples/architectures/")) return false
  if (file.startsWith("examples/checks/")) return false
  return file.endsWith(".ts")
}

const sourceFiles = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const groups = yield* Effect.forEach(roots, (dir) =>
    fs.readDirectory(dir, { recursive: true }).pipe(Effect.map((names) => names.map((name) => path.join(dir, name)).filter(isChecked)))
  )
  return groups.flat()
})

const violationsIn = (file: string, source: string) =>
  (Object.keys(rules) as ReadonlyArray<Rule>)
    .filter((rule) => !(exemptions[file] ?? []).includes(rule))
    .filter((rule) => rules[rule].pattern.test(source))
    .map((rule) => `${file}: ${rules[rule].reason}`)

const violations = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const files = yield* sourceFiles
  const found = yield* Effect.forEach(files, (file) => fs.readFileString(file).pipe(Effect.map((source) => violationsIn(file, source))))
  return found.flat()
})

describe("everything the daemon starts is owned by a scope", () => {
  it.effect("scans the infra plugins and every example config", () =>
    Effect.gen(function*() {
      const files = yield* sourceFiles
      expect(files).toContain("src/infra/Postgres.ts")
      expect(files).toContain("examples/storefront/forkyard.config.ts")
      expect(files).toContain("examples/python-compose/forkyard.config.ts")
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))))

  it.effect("no daemon or stack file can spawn, fork or signal outside a scope", () =>
    Effect.gen(function*() {
      expect(yield* violations).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))))
})
