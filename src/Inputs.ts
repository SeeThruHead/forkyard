import { Effect, Schema, type Scope } from "effect"
import type { Run } from "./Stack.ts"

export class InputsError extends Schema.TaggedError<InputsError, { readonly brand: unique symbol }>()("InputsError", {
  message: Schema.String
}) {}

export type Inputs = { readonly paths: ReadonlyArray<string> }

export type InputsTarget = { readonly name: string; readonly kind: "service" | "infra" }

export type InputsContext = {
  readonly root: string
  readonly exec: (run: Run) => Effect.Effect<string, InputsError, Scope.Scope>
}

export type InputsHook = (target: InputsTarget, context: InputsContext) => Effect.Effect<Inputs | undefined, InputsError, Scope.Scope>

const lines = (output: string) =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

const git = (...args: ReadonlyArray<string>): Run => ({ command: "git", args })

export const changedFiles = Effect.fn("Inputs.changedFiles")(function* (
  exec: (run: Run) => Effect.Effect<string, InputsError, Scope.Scope>,
  base: string
) {
  const forkPoint = (yield* exec(git("merge-base", "HEAD", base))).trim()
  const [committedOrEdited, untracked] = yield* Effect.all(
    [exec(git("diff", "--name-only", forkPoint)), exec(git("ls-files", "--others", "--exclude-standard"))],
    { concurrency: 2 }
  )
  return new Set([...lines(committedOrEdited), ...lines(untracked)])
})

const within = (paths: ReadonlyArray<string>) => (file: string) =>
  paths.some((path) => path === "." || file === path || file.startsWith(`${path.replace(/\/$/, "")}/`))

export const touched = (files: ReadonlySet<string>, inputs: Inputs) => [...files].some(within(inputs.paths))
