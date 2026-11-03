import { Effect, FileSystem, Path, Queue, Stream } from "effect"
import { matchesGlob } from "node:path"
import type { Watch } from "./Stack.ts"

type Target = { readonly directory: string; readonly recursive: boolean }

const hasWildcard = (segment: string) => /[*?[\]{}!]/.test(segment)

const ignored = (path: string) => path.split("/").some((segment) => segment === "node_modules" || segment === ".git")

export const targetOf = (glob: string): Target => {
  const segments = glob.split("/")
  const firstWildcard = segments.findIndex(hasWildcard)
  if (firstWildcard === -1) return { directory: segments.slice(0, -1).join("/") || ".", recursive: false }
  return { directory: segments.slice(0, firstWildcard).join("/") || ".", recursive: true }
}

const existingAncestor = Effect.fnUntraced(function* (
  root: string,
  directory: string
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absolute = path.join(root, directory)

  if (directory === "." || (yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false)))) return directory
  return yield* existingAncestor(root, path.dirname(directory))
})

const eventsUnder = Effect.fnUntraced(function* (root: string, target: Target) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* existingAncestor(root, target.directory)

  return fs.watch(path.join(root, directory), { recursive: target.recursive || directory !== target.directory }).pipe(
    Stream.map((event) => path.join(directory, event.path)),
    Stream.filter((changed) => !ignored(changed))
  )
})

export const changesUnder = Effect.fn("Watch.changesUnder")(function* (root: string, watch: Watch) {
  const pending = yield* Queue.sliding<void>(1)
  const streams = yield* Effect.forEach(watch.globs, (glob) => eventsUnder(root, targetOf(glob)))
  const relevant = (changed: string) => watch.globs.some((glob) => matchesGlob(changed, glob))

  yield* Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
    Stream.filter(relevant),
    Stream.debounce(watch.debounce),
    Stream.runForEach(() => Queue.offer(pending, undefined)),
    Effect.forkScoped
  )

  return pending
}, Effect.map(Queue.take))
