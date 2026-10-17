import { Cause, Context, Effect, Layer, Logger, PubSub, Ref, Stream } from "effect"
import type { DaemonLine } from "./Model.ts"

const keep = 1000

const messageOf = (message: unknown) => (Array.isArray(message) ? message.map(String).join(" ") : String(message))

const lineOf = (options: Logger.Options<unknown>): DaemonLine => ({
  at: options.date.getTime(),
  level: options.logLevel,
  message:
    Cause.hasFails(options.cause) || Cause.hasDies(options.cause)
      ? `${messageOf(options.message)} ${Cause.pretty(options.cause)}`
      : messageOf(options.message)
})

export class DaemonLog extends Context.Service<
  DaemonLog,
  { readonly logger: Logger.Logger<unknown, void>; readonly lines: Stream.Stream<DaemonLine> }
>()("forkyard/DaemonLog") {
  static readonly layer = Layer.effect(
    DaemonLog,
    Effect.gen(function* () {
      const published = yield* PubSub.unbounded<DaemonLine>()
      const recent = yield* Ref.make<ReadonlyArray<DaemonLine>>([])

      yield* PubSub.subscribe(published).pipe(
        Effect.flatMap((subscription) =>
          Stream.fromSubscription(subscription).pipe(Stream.runForEach((line) => Ref.update(recent, (all) => [...all, line].slice(-keep))))
        ),
        Effect.forkScoped
      )

      const logger = Logger.make((options) => {
        PubSub.publishUnsafe(published, lineOf(options))
      })
      const lines = Stream.unwrap(
        Ref.get(recent).pipe(Effect.map((history) => Stream.fromIterable(history).pipe(Stream.concat(Stream.fromPubSub(published)))))
      )

      return DaemonLog.of({ logger, lines })
    })
  )

  static readonly logging = Logger.layer([DaemonLog.useSync((log) => log.logger)], { mergeWithExisting: true }).pipe(
    Layer.provideMerge(DaemonLog.layer)
  )
}
