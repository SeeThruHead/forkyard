import { Context, Effect, FiberMap, Hash, Layer, Ref, Schedule, Schema, type Scope, Stream, SubscriptionRef } from "effect"

export class ReconcileError extends Schema.TaggedError<ReconcileError>()("ReconcileError", {
  resource: Schema.String,
  message: Schema.String
}) {}

export type Desired = {
  readonly id: string
  readonly kind: string
  readonly props: Readonly<Record<string, unknown>>
}

export type Observed = {
  readonly id: string
  readonly propsHash: number
  readonly alive: boolean
}

export type Provider = {
  readonly kind: string
  readonly read: (id: string) => Effect.Effect<Observed | undefined, ReconcileError>
  readonly reconcile: (desired: Desired) => Effect.Effect<void, ReconcileError, Scope.Scope>
  readonly delete: (id: string) => Effect.Effect<void, ReconcileError>
  readonly list: Effect.Effect<ReadonlyArray<string>, ReconcileError>
}

export type Action = "noop" | "create" | "replace" | "delete"

export const diff = (desired: Desired | undefined, observed: Observed | undefined): Action => {
  if (!desired) return observed ? "delete" : "noop"
  if (!observed?.alive) return "create"
  return observed.propsHash === Hash.structure(desired.props) ? "noop" : "replace"
}

export class Reconciler extends Context.Service<
  Reconciler,
  {
    readonly desire: (resources: ReadonlyArray<Desired>) => Effect.Effect<void>
    readonly plan: Effect.Effect<ReadonlyArray<readonly [string, Action]>, ReconcileError>
  }
>()("c/Reconciler") {
  static readonly layer = (providers: ReadonlyArray<Provider>) =>
    Layer.effect(
      Reconciler,
      Effect.gen(function* () {
        const byKind = Object.fromEntries(providers.map((provider) => [provider.kind, provider]))
        const desired = yield* SubscriptionRef.make<ReadonlyArray<Desired>>([])
        const running = yield* FiberMap.make<string>()
        const hashes = yield* Ref.make<Readonly<Record<string, number>>>({})

        const providerOf = (kind: string): Effect.Effect<Provider, ReconcileError> => {
          const provider = byKind[kind]
          return provider ? Effect.succeed(provider) : Effect.fail(new ReconcileError({ resource: kind, message: "no provider" }))
        }

        const apply = Effect.fn("Reconciler.apply")(function* (resource: Desired, action: Action) {
          const provider = yield* providerOf(resource.kind)
          if (action === "noop") return
          if (action === "delete") return yield* FiberMap.remove(running, resource.id)
          yield* Ref.update(hashes, (all) => ({ ...all, [resource.id]: Hash.structure(resource.props) }))
          yield* FiberMap.run(running, resource.id)(provider.reconcile(resource).pipe(Effect.andThen(Effect.never), Effect.scoped))
        })

        const plan = Effect.gen(function* () {
          const wanted = yield* SubscriptionRef.get(desired)
          return yield* Effect.forEach(wanted, (resource) =>
            providerOf(resource.kind).pipe(
              Effect.flatMap((provider) => provider.read(resource.id)),
              Effect.map((observed) => [resource.id, diff(resource, observed)] as const)
            )
          )
        })

        const reconcileAll = Effect.gen(function* () {
          const wanted = yield* SubscriptionRef.get(desired)
          const actions = yield* plan
          yield* Effect.forEach(wanted, (resource, index) => apply(resource, actions[index]?.[1] ?? "noop"), {
            concurrency: 4,
            discard: true
          })
        }).pipe(Effect.catch((error) => Effect.logError("reconcile failed", error)))

        yield* SubscriptionRef.changes(desired).pipe(
          Stream.debounce("100 millis"),
          Stream.merge(Stream.fromSchedule(Schedule.spaced("5 seconds"))),
          Stream.runForEach(() => reconcileAll),
          Effect.forkScoped
        )

        return Reconciler.of({ desire: (resources) => SubscriptionRef.set(desired, resources), plan })
      })
    )
}
