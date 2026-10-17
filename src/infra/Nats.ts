import { Effect } from "effect"
import { InfraName } from "../Ids.ts"
import type { Env, InfraServer, InfraSpec, InfraTools, Worktree } from "../Stack.ts"
import { containerName, dockerContainer, dockerReach, fetchOk, port, publish, readyOrExit } from "./Shared.ts"

export type NatsTenant = { readonly url: string; readonly monitorUrl: string; readonly subjectPrefix: string }

type Options = {
  readonly name?: string
  readonly scope: "shared" | "worktree"
  readonly image?: string
  readonly env?: (nats: NatsTenant) => Env
}

export const docker = (options: Options): InfraSpec => {
  const name = InfraName.make(options.name ?? "nats")
  const image = options.image ?? "nats:2.11-alpine"

  const start = Effect.fn("Nats.start")(function* (instance: string, tools: InfraTools) {
    const client = yield* port(name)
    const monitor = yield* port(name)
    yield* Effect.annotateCurrentSpan({ "messaging.system": "nats", "server.port": client, "forkyard.nats.monitor_port": monitor })

    const started = yield* dockerContainer(tools, {
      infra: name,
      name: containerName(name, instance),
      args: ["-p", publish(client, 4222), "-p", publish(monitor, 8222), image, "-js", "-m", "8222"]
    })
    yield* readyOrExit(name, started, fetchOk(`http://${dockerReach}:${monitor}/healthz?js-enabled-only=true`), "30 seconds")

    return { port: client, env: { NATS_MONITOR_PORT: String(monitor) }, routes: {} }
  })

  const tenant = Effect.fn("Nats.tenant")(function* (server: InfraServer, worktree: Worktree) {
    const nats: NatsTenant = {
      url: `nats://${dockerReach}:${server.port}`,
      monitorUrl: `http://${dockerReach}:${server.env.NATS_MONITOR_PORT}`,
      subjectPrefix: options.scope === "shared" ? `${worktree.id}.` : ""
    }
    yield* Effect.annotateCurrentSpan({ "messaging.system": "nats", "server.port": server.port })
    return options.env?.(nats) ?? { NATS_URL: nats.url, NATS_MONITOR_URL: nats.monitorUrl, NATS_SUBJECT_PREFIX: nats.subjectPrefix }
  })

  return { name, scope: options.scope, start, tenant }
}
