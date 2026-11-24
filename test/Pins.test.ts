import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Stream } from "effect"
import * as Database from "../src/Database.ts"
import { WorktreeId } from "../src/Ids.ts"
import { Pins } from "../src/Pins.ts"

const worktree = WorktreeId.make("main.shop")

const services = Array.from({ length: 40 }, (_, i) => `service-${i}`)

describe("pins", () => {
  it.effect("publishes every pin when many arrive at once", () =>
    Effect.gen(function* () {
      const pins = yield* Pins
      yield* Effect.forEach(services, (service) => pins.pin(worktree, service, "start"), { concurrency: "unbounded", discard: true })
      const published = yield* pins.changes(worktree, "start").pipe(Stream.runHead)

      expect(Option.map(published, (names) => names.size)).toEqual(Option.some(services.length))
    }).pipe(Effect.provide(Pins.layer.pipe(Layer.provide(Database.layer(":memory:")))))
  )
})
