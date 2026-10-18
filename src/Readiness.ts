import { type Duration, Effect, Schedule } from "effect"

export const attemptTimeout = "2 seconds"

export const pollUntilReady = <A, E, R>(
  check: Effect.Effect<A, E, R>,
  options: { readonly every: Duration.Input; readonly within: Duration.Input }
) =>
  check.pipe(Effect.timeout(attemptTimeout), Effect.retry(Schedule.spaced(options.every).pipe(Schedule.upTo({ duration: options.within }))))
