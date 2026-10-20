import { Clock, Context, Effect, Layer, Record, type Scope, Stream, SubscriptionRef } from "effect"
import type { Port, WorktreeId } from "./Ids.ts"

export type Instance = { readonly fingerprint: string; readonly owner: WorktreeId; readonly port: Port | undefined; readonly since: number }

export type Found = { readonly key: string; readonly instance: Instance }

export const instanceKey = (id: WorktreeId, name: string) => `${id}/${name}`

export class Instances extends Context.Service<
  Instances,
  {
    readonly publish: (key: string, instance: Omit<Instance, "since">) => Effect.Effect<void, never, Scope.Scope>
    readonly setPort: (key: string, port: Port | undefined) => Effect.Effect<void>
    readonly setFingerprint: (key: string, fingerprint: string) => Effect.Effect<void>
    readonly find: (fingerprint: string, besides: WorktreeId) => Effect.Effect<Found | undefined>
    readonly watch: (key: string) => Stream.Stream<Instance | undefined>
    readonly olderTwin: (key: string) => Stream.Stream<Found>
  }
>()("forkyard/Instances") {
  static readonly layer = Layer.effect(
    Instances,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<Readonly<Record<string, Instance>>>({})

      const publish = (key: string, instance: Omit<Instance, "since">) =>
        Effect.acquireRelease(
          Clock.currentTimeMillis.pipe(Effect.flatMap((since) => SubscriptionRef.update(state, Record.set(key, { ...instance, since })))),
          () => SubscriptionRef.update(state, Record.remove(key))
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
            const match = Object.entries(all)
              .filter(([, instance]) => instance.fingerprint === fingerprint && instance.owner !== besides)
              .toSorted(([, a], [, b]) => a.since - b.since)[0]
            return match ? { key: match[0], instance: match[1] } : undefined
          })
        )

      const watch = (key: string) =>
        SubscriptionRef.changes(state).pipe(
          Stream.map((all) => all[key]),
          Stream.changesWith((a, b) => a?.fingerprint === b?.fingerprint && a?.port === b?.port)
        )

      const olderTwin = (key: string) =>
        SubscriptionRef.changes(state).pipe(
          Stream.map((all) => {
            const me = all[key]
            if (!me) return undefined
            const older = Object.entries(all)
              .filter(([other, instance]) => other !== key && instance.fingerprint === me.fingerprint && instance.owner !== me.owner)
              .filter(([other, instance]) => instance.since < me.since || (instance.since === me.since && other < key))
              .toSorted(([, a], [, b]) => a.since - b.since)[0]
            return older ? { key: older[0], instance: older[1] } : undefined
          }),
          Stream.filter((found): found is Found => found !== undefined)
        )

      return Instances.of({ publish, setPort, setFingerprint, find, watch, olderTwin })
    })
  )
}
