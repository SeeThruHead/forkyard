import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node"
import { Cause, Context, Effect, Layer, Ref, Schedule, type Scope } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpMethod, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import { Port } from "./Ids.ts"
import { Router } from "./Router.ts"

const hopByHop = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]

const forwardable = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => !hopByHop.includes(key.toLowerCase())))

const hostOf = (header: string | undefined) => (header ?? "").split(":")[0] ?? ""

const hasBody = (method: string) => method !== "GET" && method !== "HEAD"

const knownMethods: ReadonlySet<string> = HttpMethod.all

const isKnownMethod = (method: string): method is HttpMethod.HttpMethod => knownMethods.has(method)

const without = <A>(all: Readonly<Record<string, A>>, host: string) =>
  Object.fromEntries(Object.entries(all).filter(([key]) => key !== host))

export class Waker extends Context.Service<
  Waker,
  {
    readonly holdWhileDown: (host: string) => Effect.Effect<void, never, Scope.Scope>
    readonly sleepUntilRequested: (host: string, wake: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
  }
>()("forkyard/Waker") {
  static readonly layer = Layer.effect(
    Waker,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const router = yield* Router
      const http = yield* HttpClient.HttpClient
      const held = yield* Ref.make<Readonly<Record<string, true>>>({})
      const sleeping = yield* Ref.make<Readonly<Record<string, Effect.Effect<void>>>>({})
      const port = Port.make("port" in server.address ? server.address.port : 0)

      const elsewhere = (target: Port | undefined): target is Port => target !== undefined && target !== port

      const awakePort = (host: string) =>
        router.routes.pipe(
          Effect.map((routes) => routes[host]?.port),
          Effect.filterOrFail(elsewhere),
          Effect.retry({ schedule: Schedule.spaced("200 millis") }),
          Effect.timeout("3 minutes")
        )

      const forward = (request: HttpServerRequest.HttpServerRequest, method: HttpMethod.HttpMethod, target: Port) =>
        http
          .execute(
            HttpClientRequest.make(method)(`http://127.0.0.1:${target}${request.url}`, {
              headers: forwardable(request.headers),
              ...(hasBody(request.method) ? { body: HttpBody.stream(request.stream) } : {})
            })
          )
          .pipe(
            Effect.map((response) =>
              HttpServerResponse.stream(response.stream, { status: response.status, headers: forwardable(response.headers) })
            )
          )

      const wakeIfAsleep = Effect.fn("Waker.wakeIfAsleep")(function* (host: string) {
        const wake = (yield* Ref.get(sleeping))[host]
        if (!wake) return
        yield* Effect.logInfo(`${host} was asked for while asleep; starting it`)
        yield* wake
      })

      const holdAndForward = Effect.fn("Waker.holdAndForward")(function* (request: HttpServerRequest.HttpServerRequest) {
        const host = hostOf(request.headers["host"])
        if (!(yield* Ref.get(held))[host]) return HttpServerResponse.text(`forkyard serves nothing at ${host}`, { status: 404 })
        const method = request.method
        if (!isKnownMethod(method)) return HttpServerResponse.text(`forkyard cannot forward ${method} requests`, { status: 405 })
        yield* wakeIfAsleep(host)
        return yield* forward(request, method, yield* awakePort(host))
      })

      const handle = HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap(holdAndForward),
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`forkyard could not start this service: ${Cause.pretty(cause).split("\n")[0]}`, { status: 502 })
          )
        )
      )

      yield* server.serve(handle)

      const holdWhileDown = (host: string) =>
        Effect.acquireRelease(
          Ref.update(held, (all) => ({ ...all, [host]: true as const })),
          () => Ref.update(held, (all) => without(all, host))
        ).pipe(Effect.andThen(router.fallback({ host, port })))

      const sleepUntilRequested = (host: string, wake: Effect.Effect<void>) =>
        Effect.acquireRelease(
          Ref.update(sleeping, (all) => ({ ...all, [host]: wake })),
          () => Ref.update(sleeping, (all) => without(all, host))
        ).pipe(Effect.asVoid)

      return Waker.of({ holdWhileDown, sleepUntilRequested })
    })
  ).pipe(
    Layer.provide(NodeHttpServer.layerServer(createServer, { port: 0, host: "127.0.0.1" })),
    Layer.provide(NodeHttpClient.layerNodeHttp)
  )
}
