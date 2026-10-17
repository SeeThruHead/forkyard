import { Effect } from "effect"
import type { EnvSource } from "./EnvSource.ts"
import { Infra, type InfraRef, type InfraSpec, make, type Run, Service, type ServiceRef, serviceRef, type Stack } from "./Stack.ts"

type ServiceDef<Names extends string, InfraNames extends string> = {
  readonly kind: "http" | "worker" | "task"
  readonly run: Run
  readonly cwd?: string
  readonly envFrom?: ReadonlyArray<EnvSource>
  readonly uses?: ReadonlyArray<NoInfer<InfraNames>>
  readonly after?: ReadonlyArray<NoInfer<Names>>
  readonly env?: (urls: Readonly<Record<NoInfer<Names>, string>>) => Readonly<Record<string, string>>
}

type Definition<InfraNames extends string, Names extends string> = {
  readonly name: string
  readonly infra: Readonly<Record<InfraNames, InfraSpec>>
  readonly services: Readonly<Record<Names, ServiceDef<Names, InfraNames>>>
}

const declareInfra = <InfraNames extends string>(infra: Readonly<Record<InfraNames, InfraSpec>>) =>
  Effect.forEach(Object.entries<InfraSpec>(infra), ([name, spec]) => Infra(spec).pipe(Effect.map((ref) => [name, ref] as const))).pipe(
    Effect.map((entries): Readonly<Record<string, InfraRef>> => Object.fromEntries(entries))
  )

const referenceServices = (names: ReadonlyArray<string>) =>
  Effect.forEach(names, (name) => serviceRef(name).pipe(Effect.map((ref) => [name, ref] as const))).pipe(
    Effect.map((entries): Readonly<Record<string, ServiceRef>> => Object.fromEntries(entries))
  )

export const defineStack = <const InfraNames extends string, const Names extends string>(
  definition: Definition<InfraNames, Names>
): Stack =>
  make(
    definition.name,
    Effect.gen(function* () {
      const entries = Object.entries<ServiceDef<Names, InfraNames>>(definition.services)
      const infra = yield* declareInfra(definition.infra)
      const refs = yield* referenceServices(entries.map(([name]) => name))
      const urls = Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, ref.url])) as Readonly<Record<Names, string>>

      yield* Effect.forEach(entries, ([name, def]) =>
        Service[def.kind](name, {
          run: def.run,
          cwd: def.cwd ?? ".",
          envFrom: def.envFrom ?? [],
          uses: (def.uses ?? []).map((infraName) => infra[infraName]!),
          after: (def.after ?? []).map((service) => refs[service]!),
          env: def.env?.(urls) ?? {}
        })
      )
    })
  )
