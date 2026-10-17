import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { createServer } from "node:http"
import { GatewayApi } from "./Api.ts"
import { Backend } from "./Backend.ts"

const Handlers = HttpApiBuilder.group(GatewayApi, "deliveries", (handlers) =>
  Effect.gen(function* () {
    const backend = yield* Backend

    return handlers
      .handle("health", () => Effect.succeed({ status: "ok" as const }))
      .handle("list", () => backend.deliveries)
      .handle("create", ({ payload }) => backend.create(payload.address))
  })
)

const Routes = HttpApiBuilder.layer(GatewayApi).pipe(
  Layer.provide(Handlers),
  Layer.provide(Backend.layer),
  Layer.provide(NodeHttpClient.layerUndici)
)

const Listener = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT")
    return NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" })
  })
)

export const ServerLive = HttpRouter.serve(Routes, { middleware: HttpMiddleware.tracer }).pipe(Layer.provide(Listener))
