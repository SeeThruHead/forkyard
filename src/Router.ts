import { Context, Effect, FileSystem, Layer, Path, Record, type Scope, Stream, SubscriptionRef } from "effect"
import type { Port } from "./Ids.ts"

export type Route = { readonly host: string; readonly port: Port; readonly upstream?: string }

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
          { loadBalancer: { servers: [{ url: `http://${route.upstream ?? upstreamHost}:${route.port}` }] } }
        ])
      )
    }
  }
}

const hostsBegin = "# forkyard begin: names for running worktrees, managed by forkyard"
const hostsEnd = "# forkyard end"

export const withHostsBlock = (content: string, hosts: ReadonlyArray<string>) => {
  const start = content.indexOf(hostsBegin)
  const end = content.indexOf(hostsEnd)
  const outside = start === -1 || end === -1 ? content : content.slice(0, start) + content.slice(end + hostsEnd.length)
  const base = outside.replace(/\n+$/, "")
  if (hosts.length === 0) return `${base}\n`
  return `${base}\n${hostsBegin}\n${hosts.map((host) => `127.0.0.1 ${host}`).join("\n")}\n${hostsEnd}\n`
}

export class Router extends Context.Service<
  Router,
  {
    readonly expose: (route: Route) => Effect.Effect<void, never, Scope.Scope>
    readonly routes: Effect.Effect<Readonly<Record<string, Route>>>
  }
>()("forkyard/Router") {
  static readonly layer = (options: { readonly file: string; readonly upstreamHost: string; readonly hostsFile?: string | undefined }) =>
    Layer.effect(
      Router,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const state = yield* SubscriptionRef.make<Readonly<Record<string, Route>>>({})

        const writeHosts = Effect.fn("Router.writeHosts")(function* (file: string, hosts: ReadonlyArray<string>) {
          const current = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          const next = withHostsBlock(current, [...hosts].sort())
          if (next !== current) yield* fs.writeFileString(file, next)
        })

        const write = Effect.fn("Router.write")(
          function* (routes: Readonly<Record<string, Route>>) {
            const temp = `${options.file}.tmp`
            yield* fs.makeDirectory(path.dirname(options.file), { recursive: true })
            yield* fs.writeFileString(temp, JSON.stringify(traefikConfig(routes, options.upstreamHost), null, 2))
            yield* fs.rename(temp, options.file)
            if (options.hostsFile) yield* writeHosts(options.hostsFile, Object.keys(routes))
            yield* Effect.annotateCurrentSpan({ "forkyard.routes": Object.keys(routes).length })
          },
          Effect.catchCause((cause) => Effect.logError("could not write the routes; the next change retries", cause))
        )

        yield* SubscriptionRef.changes(state).pipe(Stream.debounce("50 millis"), Stream.runForEach(write), Effect.forkScoped)

        const expose = (route: Route) =>
          Effect.acquireRelease(SubscriptionRef.update(state, Record.set(route.host, route)), () =>
            SubscriptionRef.update(state, Record.remove(route.host))
          ).pipe(Effect.asVoid)

        return Router.of({ expose, routes: SubscriptionRef.get(state) })
      })
    )
}
