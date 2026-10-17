import { Clock, Context, Effect, FiberMap, Latch, Layer, Metric, Option, Schema } from "effect"
import { type AbsolutePath, branchSlug, type Port, type WorktreeId, worktreeId } from "./Ids.ts"
import * as Metrics from "./Metrics.ts"
import { ForkyardError } from "./Protocol.ts"
import { type DesiredWorktree, Registry } from "./Registry.ts"
import type { Stack, Worktree } from "./Stack.ts"
import { Status } from "./Status.ts"
import { Supervisor } from "./Supervisor.ts"

export type UpRequest = {
  readonly root: AbsolutePath
  readonly branch: string
  readonly profile: string
  readonly stackFile: AbsolutePath
}

const StackExport = Schema.Struct({
  name: Schema.String,
  profiles: Schema.Array(Schema.String),
  build: Schema.declare((value): value is (...args: ReadonlyArray<never>) => unknown => typeof value === "function")
})

const loadStack = Effect.fn("Worktrees.loadStack")(function* (stackFile: AbsolutePath) {
  yield* Effect.annotateCurrentSpan({ "forkyard.stack_file": stackFile })
  const version = yield* Clock.currentTimeMillis

  const exported = yield* Effect.tryPromise({
    try: () => import(`${stackFile}?t=${version}`).then((module: { readonly default?: unknown }) => module.default),
    catch: (cause) => new ForkyardError({ message: `cannot load ${stackFile}: ${String(cause)}` })
  })
  return yield* Schema.decodeUnknownEffect(StackExport)(exported).pipe(
    Effect.as(exported as Stack),
    Effect.mapError(() => new ForkyardError({ message: `${stackFile} must \`export default make("name", ...)\` from forkyard` }))
  )
})

export class Worktrees extends Context.Service<
  Worktrees,
  {
    readonly up: (request: UpRequest) => Effect.Effect<WorktreeId, ForkyardError>
    readonly down: (id: WorktreeId) => Effect.Effect<void>
  }
>()("forkyard/Worktrees") {
  static readonly layer = (options: { readonly domain: string; readonly proxyPort: Port }) =>
    Layer.effect(
      Worktrees,
      Effect.gen(function* () {
        const supervisor = yield* Supervisor
        const status = yield* Status
        const registry = yield* Registry
        const running = yield* FiberMap.make<WorktreeId>()
        const booted = yield* Latch.make(false)

        const recordRunning = FiberMap.size(running).pipe(Effect.flatMap((count) => Metric.update(Metrics.worktreesRunning, count)))

        const baseName = (request: UpRequest) =>
          Option.match(branchSlug(request.branch), {
            onNone: () => Effect.fail(new ForkyardError({ message: `"${request.branch}" cannot be used as a name` })),
            onSome: Effect.succeed
          })

        const worktreeFor = Effect.fn("Worktrees.worktreeFor")(function* (stack: Stack, request: UpRequest) {
          const name = yield* registry.nameFor(request.root, stack.name, yield* baseName(request))
          const id = worktreeId(name, stack.name)
          yield* Effect.annotateCurrentSpan({ "forkyard.worktree": id })
          return {
            id,
            project: stack.name,
            branch: name,
            root: request.root,
            profile: request.profile,
            domain: `${id}.${options.domain}`,
            proxyPort: options.proxyPort
          } satisfies Worktree
        })

        const desired = (worktree: Worktree, request: UpRequest): DesiredWorktree => ({
          slug: worktree.id,
          root: request.root,
          branch: request.branch,
          profile: request.profile,
          stack_file: request.stackFile
        })

        const launch = (stack: Stack, worktree: Worktree) =>
          FiberMap.run(running, worktree.id, { onlyIfMissing: true })(
            supervisor.run(stack, worktree).pipe(
              Effect.scoped,
              Effect.tapCause((cause) => Effect.logError(`worktree ${worktree.id} stopped`, cause)),
              Effect.ensuring(status.clear(worktree.id)),
              Effect.ensuring(recordRunning)
            )
          )

        const refuseNameTakenElsewhere = Effect.fn("Worktrees.refuseNameTakenElsewhere")(function* (worktree: Worktree) {
          const running = (yield* status.snapshot)[worktree.id]
          if (!running || running.root === worktree.root) return
          return yield* new ForkyardError({
            message: `${worktree.id} is already running from ${running.root}. Give this checkout its own name with --branch.`
          })
        })

        const refuseUnknownProfile = (stack: Stack, profile: string) => {
          if (stack.profiles.includes(profile)) return Effect.void
          return Effect.fail(
            new ForkyardError({ message: `${stack.name} has no profile "${profile}" (profiles: ${stack.profiles.join(", ")})` })
          )
        }

        const up = Effect.fn("Worktrees.up")(function* (request: UpRequest) {
          yield* Effect.annotateCurrentSpan({ "forkyard.root": request.root, "forkyard.branch": request.branch })

          const stack = yield* loadStack(request.stackFile)
          const worktree = yield* worktreeFor(stack, request)
          yield* refuseNameTakenElsewhere(worktree)
          yield* refuseUnknownProfile(stack, request.profile)
          yield* registry.markUp(desired(worktree, request))
          const current = (yield* status.snapshot)[worktree.id]
          if (current?.profile === worktree.profile && (yield* FiberMap.has(running, worktree.id))) return worktree.id
          yield* FiberMap.remove(running, worktree.id)

          yield* status.register({
            id: worktree.id,
            project: worktree.project,
            branch: worktree.branch,
            root: worktree.root,
            profile: worktree.profile
          })
          yield* launch(stack, worktree)
          yield* recordRunning

          return worktree.id
        })

        const down = Effect.fn("Worktrees.down")(function* (id: WorktreeId) {
          yield* Effect.annotateCurrentSpan({ "forkyard.worktree": id })

          yield* registry.markDown(id)
          yield* FiberMap.remove(running, id)
          yield* recordRunning
        })

        const restore = registry.desiredUp.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows,
              (row) => up({ root: row.root, branch: row.branch, profile: row.profile, stackFile: row.stack_file }).pipe(Effect.ignore),
              {
                concurrency: "unbounded",
                discard: true
              }
            )
          )
        )

        yield* restore
        yield* Latch.open(booted)

        return Worktrees.of({ up: (request) => Latch.whenOpen(booted, up(request)), down })
      })
    )
}
