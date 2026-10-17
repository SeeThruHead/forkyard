import { Context, Effect, FileSystem, Layer, Path, Record, type Scope, Stream, SubscriptionRef } from "effect"

export type Route = { readonly host: string; readonly port: number }

const routeId = (host: string) => host.replaceAll(".", "-")

export const traefikConfig = (routes: Readonly<Record<string, Route>>, upstreamHost: string) => {
  const entries = Object.values(routes)
  return {
    http: {
      routers: Object.fromEntries(
        entries.map((route) => [routeId(route.host), { rule: `Host(\`${route.host}\`)`, service: routeId(route.host) }])
      ),
      services: Object.fromEntries(
        entries.map((route) => [
          routeId(route.host),
          { loadBalancer: { servers: [{ url: `http://${upstreamHost}:${route.port}` }] } }
        ])
      )
    }
  }
}

export class Router extends Context.Service<Router, {
  readonly expose: (route: Route) => Effect.Effect<void, never, Scope.Scope>
  readonly routes: Effect.Effect<Readonly<Record<string, Route>>>
}>()("forkyard/Router") {
  static readonly layer = (options: { readonly file: string; readonly upstreamHost: string }) =>
    Layer.effect(
      Router,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const state = yield* SubscriptionRef.make<Readonly<Record<string, Route>>>({})

        const write = Effect.fn("Router.write")(function*(routes: Readonly<Record<string, Route>>) {
            const temp = `${options.file}.tmp`
            yield* fs.makeDirectory(path.dirname(options.file), { recursive: true })
            yield* fs.writeFileString(temp, JSON.stringify(traefikConfig(routes, options.upstreamHost), null, 2))
            yield* fs.rename(temp, options.file)
            yield* Effect.annotateCurrentSpan({ "forkyard.routes": Object.keys(routes).length })
          }, Effect.orDie)

        yield* SubscriptionRef.changes(state).pipe(
          Stream.debounce("50 millis"),
          Stream.runForEach(write),
          Effect.forkScoped
        )

        const expose = (route: Route) =>
          Effect.acquireRelease(
            SubscriptionRef.update(state, Record.set(route.host, route)),
            () => SubscriptionRef.update(state, Record.remove(route.host))
          ).pipe(Effect.asVoid)

        return Router.of({ expose, routes: SubscriptionRef.get(state) })
      })
    )
}
