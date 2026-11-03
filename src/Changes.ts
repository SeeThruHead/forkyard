import { Cache, Context, Effect, Layer } from "effect"
import { ownerOfWorktree, type WorktreeId } from "./Ids.ts"
import { changedFiles, InputsError, type InputsHook, type InputsTarget, touched } from "./Inputs.ts"
import { Proc } from "./Proc.ts"
import type { Run, Worktree } from "./Stack.ts"

export type Session = {
  readonly touched: (targets: ReadonlyArray<InputsTarget>, base: string) => Effect.Effect<ReadonlySet<string>, InputsError>
}

export class Changes extends Context.Service<
  Changes,
  {
    readonly exec: (id: WorktreeId, root: string, run: Run) => Effect.Effect<string, InputsError>
    readonly session: (hook: InputsHook, worktree: Worktree) => Effect.Effect<Session>
  }
>()("forkyard/Changes") {
  static readonly layer = Layer.effect(
    Changes,
    Effect.gen(function* () {
      const proc = yield* Proc

      const scopedExec = (id: WorktreeId, root: string) => (run: Run) =>
        proc
          .exec({ owner: ownerOfWorktree(id), service: "changes", run, env: {}, cwd: root })
          .pipe(Effect.mapError((error) => new InputsError({ message: error.message })))

      const exec = (id: WorktreeId, root: string, run: Run) => scopedExec(id, root)(run).pipe(Effect.scoped)

      const session = Effect.fn("Changes.session")(function* (hook: InputsHook, worktree: Worktree) {
        const run = scopedExec(worktree.id, worktree.root)
        const cache = yield* Cache.make({ lookup: (command: Run) => run(command).pipe(Effect.scoped), capacity: 64 })
        const cachedExec = (command: Run) => Cache.get(cache, command)
        const inputsOf = (target: InputsTarget) => hook(target, { root: worktree.root, exec: cachedExec }).pipe(Effect.scoped)

        const touchedBy = Effect.fn("Changes.touched")(function* (targets: ReadonlyArray<InputsTarget>, base: string) {
          const files = yield* changedFiles(run, base).pipe(Effect.scoped)
          const hits = yield* Effect.forEach(targets, (target) =>
            inputsOf(target).pipe(Effect.map((inputs) => (inputs && touched(files, inputs) ? [target.name] : [])))
          )
          return new Set(hits.flat())
        })

        return { touched: touchedBy } satisfies Session
      })

      return Changes.of({ exec, session })
    })
  )
}
