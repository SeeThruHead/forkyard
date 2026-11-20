import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Path } from "effect"
import { findStackFile } from "../src/StackFile.ts"

const checkoutWith = Effect.fnUntraced(function* (files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped()
  yield* Effect.forEach(files, (file) =>
    fs
      .makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, file), "")))
  )
  const found = yield* findStackFile(fs, path, root)
  return Option.map(found, (file) => path.relative(root, file))
})

describe("finding a checkout's config", () => {
  it.effect("prefers the config at the root, then the one under tools/forkyard", () =>
    Effect.gen(function* () {
      expect(yield* checkoutWith(["forkyard.config.ts", "tools/forkyard/forkyard.config.ts"])).toEqual(Option.some("forkyard.config.ts"))
      expect(yield* checkoutWith(["tools/forkyard/forkyard.config.ts"])).toEqual(Option.some("tools/forkyard/forkyard.config.ts"))
      expect(yield* checkoutWith([])).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
