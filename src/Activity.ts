import { NodeHttpClient } from "@effect/platform-node"
import { Clock, Context, Effect, Layer, Schedule, SubscriptionRef } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ProxyAddress } from "./ProxyAddress.ts"
import { routeId } from "./Router.ts"

type Seen = { readonly requests: number; readonly since: number }

const requestLine = /^traefik_router_requests_total\{[^}]*router="([^"@]+)@[^"]*"[^}]*\}\s+([0-9.eE+]+)$/

export const requestsByRoute = (metrics: string): Readonly<Record<string, number>> =>
  metrics
    .split("\n")
    .map((line) => requestLine.exec(line.trim()))
    .filter((match) => match !== null)
    .reduce<Readonly<Record<string, number>>>(
      (totals, [, route = "", count = "0"]) => ({ ...totals, [route]: (totals[route] ?? 0) + Number(count) }),
      {}
    )

const advance =
  (now: number, counts: Readonly<Record<string, number>>) =>
  (seen: Readonly<Record<string, Seen>>): Readonly<Record<string, Seen>> =>
    Object.fromEntries(
      Object.entries(counts).map(([route, requests]) => {
        const before = seen[route]
        if (before && before.requests === requests) return [route, before]
        return [route, { requests, since: now }]
      })
    )

export class Activity extends Context.Service<
  Activity,
  {
    readonly quietFor: (host: string) => Effect.Effect<number | undefined>
  }
>()("forkyard/Activity") {
  static readonly layer = Layer.effect(
    Activity,
    Effect.gen(function* () {
      const proxy = yield* ProxyAddress
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const seen = yield* SubscriptionRef.make<Readonly<Record<string, Seen>>>({})

      const poll = http
        .execute(HttpClientRequest.get(`http://127.0.0.1:${proxy.port}/metrics`, { headers: { host: proxy.metricsHost } }))
        .pipe(
          Effect.flatMap((response) => response.text),
          Effect.timeout("10 seconds"),
          Effect.map(requestsByRoute),
          Effect.flatMap((counts) =>
            Clock.currentTimeMillis.pipe(Effect.flatMap((now) => SubscriptionRef.update(seen, advance(now, counts))))
          ),
          Effect.ignore
        )

      yield* poll.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)

      const quietFor = (host: string) =>
        Effect.all([SubscriptionRef.get(seen), Clock.currentTimeMillis]).pipe(
          Effect.map(([all, now]) => {
            const last = all[routeId(host)]
            return last ? now - last.since : undefined
          })
        )

      return Activity.of({ quietFor })
    })
  ).pipe(Layer.provide(NodeHttpClient.layerNodeHttp))
}
