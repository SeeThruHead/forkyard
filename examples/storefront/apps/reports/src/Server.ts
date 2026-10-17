import { NodeHttpServer } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Config, Effect, Layer } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { createServer } from "node:http"
import { ReportsApi } from "./Api.ts"
import { Sales } from "./Sales.ts"

const Handlers = HttpApiBuilder.group(ReportsApi, "reports", (handlers) =>
  Effect.gen(function* () {
    const sales = yield* Sales

    return handlers.handle("health", () => Effect.succeed({ status: "ok" as const })).handle("sales", () => sales.byProduct)
  })
)

const Database = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })

const Routes = HttpApiBuilder.layer(ReportsApi).pipe(Layer.provide(Handlers), Layer.provide(Sales.layer), Layer.provide(Database))

const Listener = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT")
    return NodeHttpServer.layer(createServer, { port })
  })
)

export const ServerLive = HttpRouter.serve(Routes, { middleware: HttpMiddleware.tracer }).pipe(Layer.provide(Listener))
