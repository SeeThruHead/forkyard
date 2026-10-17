import { Effect } from "effect"
import { InfraName } from "../Ids.ts"
import { cmd, type Env, type InfraServer, type InfraSpec, type InfraTools, type Worktree } from "../Stack.ts"
import { fetchOk, port, readyOrExit } from "./Shared.ts"

export type TemporalTenant = {
  readonly address: string
  readonly httpUrl: string
  readonly uiUrl: string
  readonly namespace: (name: string) => string
}

type Options = {
  readonly name?: string
  readonly scope: "shared" | "worktree"
  readonly namespaces: ReadonlyArray<string>
  readonly env?: (temporal: TemporalTenant) => Env
}

const upperSnake = (name: string) => name.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")

export const dev = (options: Options): InfraSpec => {
  const name = InfraName.make(options.name ?? "temporal")

  const start = Effect.fn("Temporal.start")(function* (_instance: string, tools: InfraTools) {
    const grpc = yield* port(name)
    const ui = yield* port(name)
    const http = yield* port(name)
    const namespaces = options.scope === "worktree" ? options.namespaces.flatMap((namespace) => ["--namespace", namespace]) : []
    yield* Effect.annotateCurrentSpan({ "server.port": grpc, "forkyard.temporal.ui_port": ui, "forkyard.temporal.http_port": http })
    const started = yield* tools.spawn({
      name,
      run: cmd(
        "temporal",
        "server",
        "start-dev",
        "--ip",
        "127.0.0.1",
        "--port",
        String(grpc),
        "--ui-port",
        String(ui),
        "--http-port",
        String(http),
        "--log-level",
        "warn",
        ...namespaces
      ),
      env: {}
    })
    yield* readyOrExit(name, started, fetchOk(`http://127.0.0.1:${http}/api/v1/namespaces`), "60 seconds")
    yield* readyOrExit(name, started, fetchOk(`http://127.0.0.1:${ui}/`), "30 seconds")
    return { port: grpc, env: { TEMPORAL_HTTP_PORT: String(http) }, routes: { temporal: ui } }
  })

  const tenant = Effect.fn("Temporal.tenant")(function* (server: InfraServer, worktree: Worktree, tools: InfraTools) {
    const namespace = (base: string) => (options.scope === "shared" ? `${worktree.id}-${base}` : base)
    const create = (base: string) =>
      tools
        .exec({
          name: "temporal namespace",
          run: cmd("temporal", "operator", "namespace", "create", "--address", `127.0.0.1:${server.port}`, "--namespace", namespace(base)),
          env: {},
          cwd: "/"
        })
        .pipe(Effect.scoped, Effect.ignore)
    if (options.scope === "shared") yield* Effect.forEach(options.namespaces, create, { discard: true })

    const tenant: TemporalTenant = {
      address: `127.0.0.1:${server.port}`,
      httpUrl: `http://127.0.0.1:${server.env.TEMPORAL_HTTP_PORT}`,
      uiUrl: server.urls.temporal ?? "",
      namespace
    }
    yield* Effect.annotateCurrentSpan({
      "server.address": tenant.address,
      "forkyard.temporal.namespaces": options.namespaces.map(namespace).join(", ")
    })
    const defaults: Env = Object.fromEntries([
      ["TEMPORAL_ADDRESS", tenant.address],
      ["TEMPORAL_HTTP_URL", tenant.httpUrl],
      ["TEMPORAL_UI_URL", tenant.uiUrl],
      ...options.namespaces.map((base) => [`TEMPORAL_NAMESPACE_${upperSnake(base)}`, namespace(base)])
    ])
    return { ...defaults, ...options.env?.(tenant) }
  })

  return { name, scope: options.scope, start, tenant }
}
