import { Context, Effect, Equal, Layer, Record, type Scope, Stream, SubscriptionRef } from "effect"
import type { Port, WorktreeId } from "./Ids.ts"

export type Instance = { readonly fingerprint: string; readonly port: Port | undefined }

export const instanceKey = (id: WorktreeId, name: string) => `${id}/${name}`

export const infraKey = (id: WorktreeId, name: string) => `${id}/infra:${name}`

export class Instances extends Context.Service<
  Instances,
  {
    readonly publish: (key: string, instance: Instance) => Effect.Effect<void, never, Scope.Scope>
    readonly setPort: (key: string, port: Port | undefined) => Effect.Effect<void>
    readonly get: (key: string) => Effect.Effect<Instance | undefined>
    readonly watch: (key: string) => Stream.Stream<Instance | undefined>
  }
>()("forkyard/Instances") {
  static readonly layer = Layer.effect(
    Instances,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<Readonly<Record<string, Instance>>>({})

      const publish = (key: string, instance: Instance) =>
        Effect.acquireRelease(SubscriptionRef.update(state, Record.set(key, instance)), () =>
          SubscriptionRef.update(state, Record.remove(key))
        ).pipe(Effect.asVoid)

      const setPort = (key: string, port: Port | undefined) =>
        SubscriptionRef.update(state, (all) => {
          const current = all[key]
          if (!current) return all
          return { ...all, [key]: { ...current, port } }
        })

      const get = (key: string) => SubscriptionRef.get(state).pipe(Effect.map((all) => all[key]))

      const watch = (key: string) =>
        SubscriptionRef.changes(state).pipe(
          Stream.map((all) => all[key]),
          Stream.changesWith((a, b) => Equal.equals(a?.fingerprint, b?.fingerprint) && a?.port === b?.port)
        )

      return Instances.of({ publish, setPort, get, watch })
    })
  )
}
