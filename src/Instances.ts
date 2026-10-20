import { Context, Effect, Layer, Record, type Scope, Stream, SubscriptionRef } from "effect"
import type { Port, WorktreeId } from "./Ids.ts"

export type Instance = { readonly fingerprint: string; readonly owner: WorktreeId; readonly port: Port | undefined }

export type Found = { readonly key: string; readonly instance: Instance }

export const instanceKey = (id: WorktreeId, name: string) => `${id}/${name}`

export class Instances extends Context.Service<
  Instances,
  {
    readonly publish: (key: string, instance: Instance) => Effect.Effect<void, never, Scope.Scope>
    readonly setPort: (key: string, port: Port | undefined) => Effect.Effect<void>
    readonly setFingerprint: (key: string, fingerprint: string) => Effect.Effect<void>
    readonly find: (fingerprint: string, besides: WorktreeId) => Effect.Effect<Found | undefined>
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

      const setFingerprint = (key: string, fingerprint: string) =>
        SubscriptionRef.update(state, (all) => {
          const current = all[key]
          if (!current) return all
          return { ...all, [key]: { ...current, fingerprint } }
        })

      const find = (fingerprint: string, besides: WorktreeId) =>
        SubscriptionRef.get(state).pipe(
          Effect.map((all) => {
            const match = Object.entries(all).find(([, instance]) => instance.fingerprint === fingerprint && instance.owner !== besides)
            return match ? { key: match[0], instance: match[1] } : undefined
          })
        )

      const watch = (key: string) =>
        SubscriptionRef.changes(state).pipe(
          Stream.map((all) => all[key]),
          Stream.changesWith((a, b) => a?.fingerprint === b?.fingerprint && a?.port === b?.port)
        )

      return Instances.of({ publish, setPort, setFingerprint, find, watch })
    })
  )
}
