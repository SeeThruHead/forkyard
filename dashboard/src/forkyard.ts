import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"
import { Atom, AtomRpc } from "effect/reactivity"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { ProcessOwner, type RunId, ServiceName, WorktreeId } from "../../src/Ids.ts"
import type { DaemonLine, RunLine } from "../../src/Model.ts"
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

const client = Effect.gen(function* () {
  return yield* Forkyard
})

const stream = <A, E>(make: (forkyard: typeof Forkyard.Service) => Stream.Stream<A, E>) => Stream.unwrap(Effect.map(client, make))

export const snapshotAtom = Forkyard.runtime.atom(stream((forkyard) => forkyard("Status", undefined))).pipe(Atom.keepAlive)

export const runLogAtom = Atom.family((runId: RunId) =>
  Forkyard.runtime.atom(
    stream((forkyard) => forkyard("RunLog", { runId })).pipe(
      Stream.groupedWithin(500, "120 millis"),
      Stream.scan<ReadonlyArray<RunLine>, ReadonlyArray<RunLine>>(
        () => [],
        (all, chunk) => [...all, ...chunk].slice(-4000)
      )
    )
  )
)

export const runsKey = (owner: ProcessOwner, service: string, version: string) => `${owner}|${service}|${version}`

export const runsAtom = Atom.family((key: string) => {
  const [owner, service] = key.split("|") as [string, string]
  return Forkyard.runtime.atom(Effect.flatMap(client, (forkyard) => forkyard("Runs", { owner: ProcessOwner.make(owner), service })))
})

export const envKey = (id: WorktreeId, service: ServiceName, version: string) => `${id}|${service}|${version}`

export const envAtom = Atom.family((key: string) => {
  const [id, service] = key.split("|") as [string, string]
  return Forkyard.runtime.atom(
    Effect.flatMap(client, (forkyard) => forkyard("Env", { id: WorktreeId.make(id), service: ServiceName.make(service) }))
  )
})

export const restartAtom = Forkyard.runtime.fn((target: { readonly id: WorktreeId; readonly service: ServiceName }) =>
  Effect.flatMap(client, (forkyard) => forkyard("Restart", target)).pipe(
    Effect.withSpan("Dashboard.restart", { attributes: { "forkyard.worktree": target.id, "forkyard.service": target.service } })
  )
)

export const usageAtom = Forkyard.runtime.atom(stream((forkyard) => forkyard("Usage", undefined))).pipe(Atom.keepAlive)

export const daemonLogAtom = Forkyard.runtime
  .atom(
    stream((forkyard) => forkyard("DaemonLogs", undefined)).pipe(
      Stream.groupedWithin(500, "120 millis"),
      Stream.scan<ReadonlyArray<DaemonLine>, ReadonlyArray<DaemonLine>>(
        () => [],
        (all, chunk) => [...all, ...chunk].slice(-2000)
      )
    )
  )
  .pipe(Atom.keepAlive)

export type TaggedLine = { readonly key: string; readonly at: number; readonly line: string }

export const followKey = (runs: ReadonlyArray<readonly [string, RunId]>) => runs.map(([key, runId]) => `${key}=${runId}`).join(",")

const parseFollowKey = (key: string) =>
  key
    .split(",")
    .filter(Boolean)
    .map((part) => {
      const [name, runId] = part.split("=") as [string, string]
      return [name, Number(runId) as RunId] as const
    })

export const allLogsAtom = Atom.family((key: string) =>
  Forkyard.runtime.atom(
    stream((forkyard) =>
      Stream.mergeAll(
        parseFollowKey(key).map(([name, runId]) =>
          forkyard("RunLog", { runId }).pipe(Stream.map((line): TaggedLine => ({ key: name, at: line.at, line: line.line })))
        ),
        { concurrency: "unbounded" }
      )
    ).pipe(
      Stream.groupedWithin(1000, "150 millis"),
      Stream.scan<ReadonlyArray<TaggedLine>, ReadonlyArray<TaggedLine>>(
        () => [],
        (all, chunk) => [...all, ...chunk].sort((a, b) => a.at - b.at).slice(-5000)
      )
    )
  )
)

export const stopAtom = Forkyard.runtime.fn((id: WorktreeId) =>
  Effect.flatMap(client, (forkyard) => forkyard("Down", { id })).pipe(
    Effect.withSpan("Dashboard.stop", { attributes: { "forkyard.worktree": id } })
  )
)
