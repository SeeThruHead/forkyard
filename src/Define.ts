import { Effect } from "effect"
import type { EnvSource } from "./EnvSource.ts"
import { CurrentWorktree, Infra, type InfraRef, type InfraSpec, make, type Run, Service, type ServiceRef, type Stack, urlOf } from "./Stack.ts"

type ServiceDef<Names extends string, InfraNames extends string> = {
  readonly kind: "http" | "worker" | "task"
  readonly run: Run
  readonly cwd?: string
  readonly envFrom?: ReadonlyArray<EnvSource>
  readonly uses?: ReadonlyArray<NoInfer<InfraNames>>
  readonly after?: ReadonlyArray<NoInfer<Names>>
  readonly env?: (urls: Readonly<Record<NoInfer<Names>, string>>) => Readonly<Record<string, string>>
}

export const defineStack = <const InfraNames extends string, const Names extends string>(definition: {
  readonly name: string
  readonly infra: Readonly<Record<InfraNames, InfraSpec>>
  readonly services: Readonly<Record<Names, ServiceDef<Names, InfraNames>>>
}): Stack =>
  make(
    definition.name,
    Effect.gen(function*() {
      const infra = Object.fromEntries(
        yield* Effect.forEach(Object.entries<InfraSpec>(definition.infra), ([name, spec]) =>
          Infra(spec).pipe(Effect.map((ref) => [name, ref] as const))
        )
      ) as Readonly<Record<string, InfraRef>>
      const worktree = yield* CurrentWorktree
      const entries = Object.entries<ServiceDef<Names, InfraNames>>(definition.services)
      const urls = Object.fromEntries(entries.map(([name]) => [name, urlOf(worktree, name)])) as Record<Names, string>
      yield* Effect.forEach(entries, ([name, def]) =>
        Service[def.kind](name, {
          run: def.run,
          cwd: def.cwd ?? ".",
          envFrom: def.envFrom ?? [],
          uses: (def.uses ?? []).map((infraName) => infra[infraName]!),
          after: (def.after ?? []).map((service): ServiceRef => ({ service, url: urls[service] })),
          env: def.env?.(urls) ?? {}
        })
      )
    })
  )
