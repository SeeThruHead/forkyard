import { Effect } from "effect"
import { spawn } from "node:child_process"

export const leaked = Effect.runFork(Effect.void)

export const wrapper = (name: string) =>
  Effect.gen(function* () {
    return name
  })

export const noisy = Effect.fn("noisy")(function* (id: string) {
  yield* Effect.logInfo("half way through")
  const result = yield* Effect.succeed(id).pipe(Effect.orElseSucceed(() => "fallback"))

  if (result) {
    yield* Effect.log("one")
    yield* Effect.log("two")
  }

  return yield* Effect.gen(function* () {
    return spawn
  })
})
