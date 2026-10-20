import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { WorktreeId } from "../src/Ids.ts"
import { Instances } from "../src/Instances.ts"

const main = WorktreeId.make("main.shop")
const feature = WorktreeId.make("feat.shop")

describe("instances", () => {
  it.effect("an own copy sees the older copy once its fingerprint matches again", () =>
    Effect.gen(function* () {
      const instances = yield* Instances
      const scope = yield* Scope.make()
      yield* instances.publish("main.shop/api", { fingerprint: "a", owner: main, port: undefined }).pipe(Scope.provide(scope))
      yield* TestClock.adjust("1 second")
      yield* instances.publish("feat.shop/api", { fingerprint: "b", owner: feature, port: undefined }).pipe(Scope.provide(scope))
      const twin = yield* instances.olderTwin("feat.shop/api").pipe(Stream.runHead, Effect.forkChild)
      yield* instances.setFingerprint("feat.shop/api", "a")
      const found = yield* Fiber.join(twin)
      expect(Option.map(found, (value) => value.key)).toEqual(Option.some("main.shop/api"))
      const fromMain = yield* instances.olderTwin("main.shop/api").pipe(Stream.runHead, Effect.timeoutOption("10 millis"), Effect.forkChild)
      yield* TestClock.adjust("1 second")
      expect(Option.flatten(yield* Fiber.join(fromMain))).toEqual(Option.none())
      expect((yield* instances.find("a", WorktreeId.make("other.shop")))?.key).toEqual("main.shop/api")
    }).pipe(Effect.provide(Instances.layer))
  )
})
