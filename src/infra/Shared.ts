import { Effect } from "effect"
import { allocatePort } from "../Ports.ts"
import { pollUntilReady, unlessItExits } from "../Readiness.ts"
import { cmd, type Env, InfraError, type InfraProcess, type InfraTools } from "../Stack.ts"

export const port = (infra: string) => allocatePort.pipe(Effect.mapError((error) => new InfraError({ infra, message: error.message })))

const instanceName = process.env.FORKYARD_INSTANCE ? `-${process.env.FORKYARD_INSTANCE}` : ""

export const dockerUpstream = process.env.FORKYARD_DOCKER_HOST

export const dockerReach = dockerUpstream ?? "127.0.0.1"

export const publish = (hostPort: number, containerPort: number) =>
  `${process.env.FORKYARD_DOCKER_BIND ?? "127.0.0.1"}:${hostPort}:${containerPort}`

export const upperSnake = (name: string) => name.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")

export const forkyardName = (...parts: ReadonlyArray<string | number>) => [`forkyard${instanceName}`, ...parts].join("-")

export const containerName = (infra: string, instance: string) => forkyardName(infra, instance.replaceAll(/[^a-zA-Z0-9]+/g, "-"))

export const readyOrExit = <A, E, R>(infra: string, started: InfraProcess, check: Effect.Effect<A, E, R>, within: `${number} seconds`) =>
  pollUntilReady(infra, check, { every: "200 millis", within }).pipe(
    unlessItExits(started),
    Effect.mapError((error) => new InfraError({ infra, message: error.message })),
    Effect.withSpan("Shared.readyOrExit", { attributes: { "forkyard.infra": infra } })
  )

export const fetchOk = (url: string) =>
  Effect.tryPromise((signal) =>
    fetch(url, { signal }).then((response) => (response.ok ? response : Promise.reject(new Error(`${response.status}`))))
  )

export const removeContainer = (tools: InfraTools, name: string) =>
  tools.exec({ name: "docker rm", run: cmd("docker", "rm", "-f", name), env: {}, cwd: "/" }).pipe(Effect.scoped, Effect.ignore)

export const dockerContainer = Effect.fn("Shared.dockerContainer")(function* (
  tools: InfraTools,
  options: { readonly infra: string; readonly name: string; readonly args: ReadonlyArray<string>; readonly env?: Env }
) {
  yield* Effect.annotateCurrentSpan({ "container.name": options.name, "forkyard.infra": options.infra })
  const stopGracefully = tools
    .exec({ name: "docker stop", run: cmd("docker", "stop", "--time", "20", options.name), env: {}, cwd: "/" })
    .pipe(
      Effect.scoped,
      Effect.ignore,
      Effect.andThen(removeContainer(tools, options.name)),
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
