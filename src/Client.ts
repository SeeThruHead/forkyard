import { NodeSocket } from "@effect/platform-node"
import { Context, Layer } from "effect"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc"
import { ForkyardRpcs } from "./Protocol.ts"

export class ForkyardClient extends Context.Service<ForkyardClient, RpcClient.FromGroup<typeof ForkyardRpcs, RpcClientError.RpcClientError>>()("forkyard/Client") {
  static readonly layer = (socket: string) =>
    Layer.effect(ForkyardClient, RpcClient.make(ForkyardRpcs)).pipe(
      Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
      Layer.provide(NodeSocket.layerNet({ path: socket })),
      Layer.provide(RpcSerialization.layerNdjson)
    )
}
