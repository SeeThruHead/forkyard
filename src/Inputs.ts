import { Effect, Schema, type Scope } from "effect"
import { createHash } from "node:crypto"
import type { Run } from "./Stack.ts"

export class InputsError extends Schema.TaggedError<InputsError>()("InputsError", {
  message: Schema.String
}) {}

export type Inputs = { readonly paths: ReadonlyArray<string> } | { readonly hash: string }

export type InputsTarget = { readonly name: string; readonly kind: "service" | "infra" }

export type InputsContext = {
  readonly root: string
  readonly exec: (run: Run) => Effect.Effect<string, InputsError, Scope.Scope>
}

export type InputsHook = (target: InputsTarget, context: InputsContext) => Effect.Effect<Inputs | undefined, InputsError, Scope.Scope>

export type Snapshot = {
  readonly tracked: ReadonlyMap<string, string>
  readonly changed: ReadonlyMap<string, string>
}

export type SnapshotTools = {
  readonly exec: (run: Run) => Effect.Effect<string, InputsError, Scope.Scope>
  readonly contentHash: (path: string) => Effect.Effect<string>
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const records = (output: string) => output.split("\0").filter((record) => record.length > 0)

const trackedEntry = (record: string): readonly [string, string] | undefined => {
  const [meta, path] = record.split("\t")
  const sha = meta?.split(" ")[1]
  if (!path || !sha) return undefined
  return [path, sha]
}

const changedPath = (record: string) => record.slice(3)

const git = (...args: ReadonlyArray<string>): Run => ({ command: "git", args })

export const snapshotOf = Effect.fn("Inputs.snapshotOf")(function* (tools: SnapshotTools) {
  const [listed, status] = yield* Effect.all(
    [tools.exec(git("ls-files", "-s", "-z")), tools.exec(git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"))],
    { concurrency: 2 }
  )
  const tracked = new Map(records(listed).flatMap((record) => [trackedEntry(record)].filter((entry) => entry !== undefined)))
  const changedPaths = records(status).map(changedPath)
  const changed = new Map(
    yield* Effect.forEach(changedPaths, (path) => tools.contentHash(path).pipe(Effect.map((hash) => [path, hash] as const)), {
      concurrency: 16
    })
  )
  return { tracked, changed } satisfies Snapshot
})

const within = (paths: ReadonlyArray<string>) => (file: string) =>
  paths.some((path) => path === "." || file === path || file.startsWith(`${path.replace(/\/$/, "")}/`))

export const codeHash = (snapshot: Snapshot, inputs: Inputs) => {
  if ("hash" in inputs) return inputs.hash
  const inside = within(inputs.paths)
  const files = new Map([
    ...[...snapshot.tracked].filter(([file]) => inside(file)),
    ...[...snapshot.changed].filter(([file]) => inside(file))
  ])
  return sha256(
    [...files]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([file, hash]) => `${file}\0${hash}`)
      .join("\n")
  )
}

export const envHash = (env: Readonly<Record<string, string>>, domains: ReadonlyArray<string>, ignored: ReadonlyArray<string>) =>
  sha256(
    Object.entries(env)
      .filter(([key]) => !ignored.includes(key))
      .map(([key, value]) => `${key}=${domains.reduce((text, domain) => text.replaceAll(domain, "@"), value)}`)
      .sort()
      .join("\n")
  )

export const combine = (...parts: ReadonlyArray<string>) => sha256(parts.join("|"))
