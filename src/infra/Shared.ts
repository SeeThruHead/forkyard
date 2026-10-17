import { Effect, Schedule } from "effect"
import { allocatePort } from "../Ports.ts"
import { cmd, type Env, InfraError, type InfraProcess, type InfraTools, type Run } from "../Stack.ts"

export const port = (infra: string) => allocatePort.pipe(Effect.mapError((error) => new InfraError({ infra, message: error.message })))

export const containerName = (infra: string, instance: string) => `forkyard-${infra}-${instance.replaceAll(/[^a-zA-Z0-9]+/g, "-")}`

export const waitUntil = <A, E, R>(infra: string, check: Effect.Effect<A, E, R>, within: `${number} seconds`) =>
  check.pipe(
    Effect.retry(Schedule.spaced("200 millis").pipe(Schedule.upTo({ duration: within }))),
    Effect.mapError(() => new InfraError({ infra, message: `not ready within ${within}` }))
  )

export const readyOrExit = Effect.fn("Shared.readyOrExit")(function* <A, E, R>(
  infra: string,
  started: InfraProcess,
  check: Effect.Effect<A, E, R>,
  within: `${number} seconds`
) {
  const exitedEarly = started.exited.pipe(
    Effect.flatMap((code) =>
      started.output.pipe(
        Effect.flatMap((output) =>
          Effect.fail(new InfraError({ infra, message: `exited with ${code} before it was ready:\n${output.join("\n")}` }))
        )
      )
    )
  )
  return yield* waitUntil(infra, check, within).pipe(Effect.raceFirst(exitedEarly))
})

export const fetchOk = (url: string) =>
  Effect.tryPromise(() => fetch(url).then((response) => (response.ok ? response : Promise.reject(new Error(`${response.status}`)))))

export const dockerContainer = Effect.fn("Shared.dockerContainer")(function* (
  tools: InfraTools,
  options: { readonly infra: string; readonly name: string; readonly args: ReadonlyArray<string>; readonly env?: Env }
) {
  yield* Effect.annotateCurrentSpan({ "container.name": options.name, "forkyard.infra": options.infra })
  const docker = (label: string, run: Run) => tools.exec({ name: label, run, env: {}, cwd: "/" }).pipe(Effect.scoped, Effect.ignore)
  const stopGracefully = docker("docker stop", cmd("docker", "stop", "--time", "20", options.name)).pipe(
    Effect.andThen(docker("docker rm", cmd("docker", "rm", "-f", options.name))),
    Effect.withSpan("Shared.dockerStop", { attributes: { "container.name": options.name } })
  )
  yield* Effect.addFinalizer(() => stopGracefully)
  yield* stopGracefully
  return yield* tools.spawn({
    name: options.infra,
    run: cmd("docker", "run", "--rm", "--name", options.name, "--label", "forkyard.owner=forkyard", ...options.args),
    env: options.env ?? {}
  })
})
