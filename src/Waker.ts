import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node"
import { Cause, Context, Effect, Layer, Ref, Schedule, type Scope } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import { Port } from "./Ids.ts"
import { Router } from "./Router.ts"

const hopByHop = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]

const forwardable = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => !hopByHop.includes(key.toLowerCase())))

const hostOf = (header: string | undefined) => (header ?? "").split(":")[0] ?? ""

const hasBody = (method: string) => method !== "GET" && method !== "HEAD"

export class Waker extends Context.Service<
  Waker,
  {
    readonly sleepUntilRequested: (host: string, wake: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
  }
>()("forkyard/Waker") {
  static readonly layer = Layer.effect(
    Waker,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const router = yield* Router
      const http = yield* HttpClient.HttpClient
      const sleeping = yield* Ref.make<Readonly<Record<string, Effect.Effect<void>>>>({})
      const port = Port.make("port" in server.address ? server.address.port : 0)

      const awakePort = (host: string) =>
        router.routes.pipe(
          Effect.map((routes) => routes[host]?.port),
          Effect.filterOrFail((target): target is Port => target !== undefined && target !== port),
          Effect.retry({ schedule: Schedule.spaced("200 millis") }),
          Effect.timeout("3 minutes")
        )

      const forward = (request: HttpServerRequest.HttpServerRequest, target: Port) =>
        http
          .execute(
            HttpClientRequest.make(request.method)(`http://127.0.0.1:${target}${request.url}`, {
              headers: forwardable(request.headers),
              ...(hasBody(request.method) ? { body: HttpBody.stream(request.stream) } : {})
            })
          )
          .pipe(
            Effect.map((response) =>
              HttpServerResponse.stream(response.stream, { status: response.status, headers: forwardable(response.headers) })
            )
          )

      const wakeAndForward = Effect.fn("Waker.wake")(function* (request: HttpServerRequest.HttpServerRequest) {
        const host = hostOf(request.headers["host"])
        const wake = (yield* Ref.get(sleeping))[host]
        if (!wake) return HttpServerResponse.text(`nothing is asleep at ${host}`, { status: 404 })
        yield* Effect.logInfo(`${host} was asked for while asleep; starting it`)
        yield* wake
        return yield* forward(request, yield* awakePort(host))
      })

      const handle = HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap(wakeAndForward),
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`forkyard could not start this service: ${Cause.pretty(cause).split("\n")[0]}`, { status: 502 })
          )
        )
      )

      yield* server.serve(handle)

      const sleepUntilRequested = (host: string, wake: Effect.Effect<void>) =>
        Effect.acquireRelease(
          Ref.update(sleeping, (all) => ({ ...all, [host]: wake })),
          () => Ref.update(sleeping, (all) => Object.fromEntries(Object.entries(all).filter(([sleeper]) => sleeper !== host)))
        ).pipe(Effect.andThen(router.expose({ host, port })))

      return Waker.of({ sleepUntilRequested })
    })
  ).pipe(
    Layer.provide(NodeHttpServer.layerServer(createServer, { port: 0, host: "127.0.0.1" })),
    Layer.provide(NodeHttpClient.layerNodeHttp)
  )
}
