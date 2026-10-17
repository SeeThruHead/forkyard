import { Effect } from "effect"
import { cmd, type Env, type InfraServer, type InfraSpec, type InfraTools, type Worktree } from "../Stack.ts"

type Options = {
  readonly name?: string
  readonly file?: string
  readonly env?: (sqlite: { readonly path: string }) => Env
}

export const file = (options: Options = {}): InfraSpec => {
  const name = options.name ?? "sqlite"

  const tenant = Effect.fn("Sqlite.tenant")(function*(_server: InfraServer, worktree: Worktree, tools: InfraTools) {
    const dir = `${worktree.root}/.forkyard`
    yield* tools.exec({ name: "mkdir", run: cmd("mkdir", "-p", dir), env: {}, cwd: "/" }).pipe(Effect.scoped)
    const path = `${dir}/${options.file ?? `${name}.sqlite`}`
    yield* Effect.annotateCurrentSpan({ "db.system.name": "sqlite", "db.namespace": path })
    return options.env?.({ path }) ?? { DATABASE_PATH: path }
  })

  return { name, scope: "worktree", start: () => Effect.succeed({ port: 0, env: {}, routes: {} }), tenant }
}
