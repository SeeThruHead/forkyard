import { Effect } from "effect"
import { spawn } from "node:child_process"

export const leaked = Effect.runFork(Effect.void)

export const signalled = () => process.kill(1, "SIGTERM")

export const wrapper = (name: string) =>
  Effect.gen(function* () {
    return [name, spawn]
  })
