import { Effect, Predicate, Schedule, Schema } from "effect"

export class NotReady extends Schema.TaggedError<NotReady>()("NotReady", { message: Schema.String }) {}

export class ExitedBeforeReady extends Schema.TaggedError<ExitedBeforeReady>()("ExitedBeforeReady", { message: Schema.String }) {}

export type Exits = {
  readonly exited: Effect.Effect<number>
  readonly output: Effect.Effect<ReadonlyArray<string>>
}

const lastAnswer = (error: unknown) => {
  if (Predicate.isTagged(error, "TimeoutError")) return "it did not answer"
  if (error instanceof Error) return error.message
  return String(error)
}

export const pollUntilReady = <A, E, R>(
  what: string,
  check: Effect.Effect<A, E, R>,
  options: { readonly every: `${number} millis`; readonly within: `${number} seconds` }
) =>
  check.pipe(
    Effect.timeout("2 seconds"),
    Effect.retry(Schedule.spaced(options.every).pipe(Schedule.upTo({ duration: options.within }))),
    Effect.mapError((error) => new NotReady({ message: `${what} was not ready within ${options.within}: ${lastAnswer(error)}` }))
  )

export const unlessItExits =
  (process: Exits) =>
  <A, E, R>(ready: Effect.Effect<A, E, R>) =>
    ready.pipe(
      Effect.raceFirst(
        process.exited.pipe(
          Effect.flatMap((code) => process.output.pipe(Effect.map((output) => [`exited with ${code} before it was ready`, ...output]))),
          Effect.flatMap((lines) => Effect.fail(new ExitedBeforeReady({ message: lines.join("\n") })))
        )
      )
    )
