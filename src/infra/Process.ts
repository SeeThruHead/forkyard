import { Effect } from "effect"
import { InfraName, type Port } from "../Ids.ts"
import { type Env, InfraError, type InfraServer, type InfraSpec, type InfraTools, type Run, toRun, type Worktree } from "../Stack.ts"
import { fetchOk, port, readyOrExit, upperSnake } from "./Shared.ts"

export type ProcessTenant = {
  readonly url: string
  readonly routedUrl: string
  readonly port: Port
  readonly ports: Readonly<Record<string, string>>
}

type Options = {
  readonly name: string
  readonly scope: "shared" | "worktree"
  readonly run: string | Run
  readonly cwd?: string
  readonly port: string
  readonly ports?: ReadonlyArray<string>
  readonly health?: string
  readonly env?: Env
  readonly uses?: ReadonlyArray<InfraSpec>
  readonly provides?: (process: ProcessTenant, worktree: Worktree) => Env
}

export const infra = (options: Options): InfraSpec => {
  const name = InfraName.make(options.name)
  const health = options.health ?? "/health"
  const provides = options.provides ?? ((process: ProcessTenant) => ({ [`${upperSnake(options.name)}_URL`]: process.url }))

  const start = Effect.fn("Process.start")(function* (_instance: string, tools: InfraTools, origin: Worktree, usesEnv: Env) {
    const listen = yield* port(name)
    const extra = yield* Effect.forEach(options.ports ?? [], (key) =>
      port(name).pipe(Effect.map((allocated) => [key, String(allocated)] as const))
    )
    const named: Env = Object.fromEntries(extra)
    const cwd = options.cwd ? `${origin.root}/${options.cwd}` : origin.root
    yield* Effect.annotateCurrentSpan({ "server.port": listen, "forkyard.infra.origin": origin.id })

    const started = yield* tools.spawn({
      name,
      run: toRun(options.run),
      env: { ...usesEnv, ...options.env, ...named, [options.port]: String(listen) },
      cwd
    })
    yield* readyOrExit(name, started, fetchOk(`http://127.0.0.1:${listen}${health}`), "60 seconds")

    return { port: listen, env: named, routes: { [options.name]: listen } }
  })

  const tenant = Effect.fn("Process.tenant")(function* (server: InfraServer, worktree: Worktree) {
    const listen = server.port
    if (!listen) return yield* new InfraError({ infra: name, message: "process has no port" })
    yield* Effect.annotateCurrentSpan({ "server.port": listen, "forkyard.worktree": worktree.id })
    return provides(
      { url: `http://127.0.0.1:${listen}`, routedUrl: server.urls[options.name] ?? "", port: listen, ports: server.env },
      worktree
    )
  })

  return { name, scope: options.scope, sharedBy: "project", uses: options.uses ?? [], start, tenant }
}
