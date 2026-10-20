import { Context, Effect, Layer, Record, type Scope, Stream, SubscriptionRef } from "effect"
import type { Port, WorktreeId } from "./Ids.ts"

export const instanceKey = (id: WorktreeId, name: string) => `${id}/${name}`

export class Instances extends Context.Service<
  Instances,
  {
    readonly publish: (key: string, port: Port) => Effect.Effect<void, never, Scope.Scope>
    readonly watch: (key: string) => Stream.Stream<Port | undefined>
  }
>()("forkyard/Instances") {
  static readonly layer = Layer.effect(
    Instances,
    Effect.gen(function* () {
      const ports = yield* SubscriptionRef.make<Readonly<Record<string, Port>>>({})

      const publish = (key: string, port: Port) =>
        Effect.acquireRelease(SubscriptionRef.update(ports, Record.set(key, port)), () =>
          SubscriptionRef.update(ports, Record.remove(key))
        ).pipe(Effect.asVoid)

      const watch = (key: string) =>
        SubscriptionRef.changes(ports).pipe(
          Stream.map((all) => all[key]),
          Stream.changes
        )

      return Instances.of({ publish, watch })
    })
  )
}
