import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"
import { Atom, AtomRpc } from "effect/reactivity"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import type { RunLine } from "../../src/Model.ts"
import { ForkyardRpcs } from "../../src/Protocol.ts"

const rpcUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`

Atom.runtime.addGlobalLayer(
  OtlpTracer.layer({
    url: `${location.origin}/otlp/v1/traces`,
    resource: { serviceName: "forkyard-dashboard", attributes: { "service.namespace": "forkyard" } },
    exportInterval: "1 second"
  }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
)

export const mapleUrl = `${location.protocol}//${location.host.replace(/^forkyard\./, "maple.")}`

export const mapleLink = (view: "traces" | "logs", query: Readonly<Record<string, string>>) =>
  `${mapleUrl}/#/${view}?${new URLSearchParams(query).toString()}`

export class Forkyard extends AtomRpc.Service<Forkyard>()("Forkyard", {
  group: ForkyardRpcs,
  protocol: RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Socket.layerWebSocket(rpcUrl)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson)
  )
}) {}

const client = Effect.gen(function*() {
  return yield* Forkyard
})

const stream = <A, E>(make: (forkyard: typeof Forkyard.Service) => Stream.Stream<A, E>) => Stream.unwrap(Effect.map(client, make))

export const snapshotAtom = Forkyard.runtime.atom(stream((forkyard) => forkyard("Status", undefined))).pipe(Atom.keepAlive)

export const runLogAtom = Atom.family((runId: number) =>
  Forkyard.runtime.atom(
    stream((forkyard) => forkyard("RunLog", { runId })).pipe(
      Stream.groupedWithin(500, "120 millis"),
      Stream.scan<ReadonlyArray<RunLine>, ReadonlyArray<RunLine>>(() => [], (all, chunk) => [...all, ...chunk].slice(-4000))
    )
  )
)

export const runsAtom = Atom.family((key: string) => {
  const [id, service] = key.split("|") as [string, string]
  return Forkyard.runtime.atom(Effect.flatMap(client, (forkyard) => forkyard("Runs", { id, service })))
})

export const envAtom = Atom.family((key: string) => {
  const [id, service] = key.split("|") as [string, string]
  return Forkyard.runtime.atom(Effect.flatMap(client, (forkyard) => forkyard("Env", { id, service })))
})

export const restartAtom = Forkyard.runtime.fn((target: { readonly id: string; readonly service: string }) =>
  Effect.flatMap(client, (forkyard) => forkyard("Restart", target)).pipe(
    Effect.withSpan("Dashboard.restart", { attributes: { "forkyard.worktree": target.id, "forkyard.service": target.service } })
  )
)
