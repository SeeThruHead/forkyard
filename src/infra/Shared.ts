import { Config, Context, Effect, Layer, Schema } from "effect"
import { allocatePort } from "../Ports.ts"
import { pollUntilReady, unlessItExits } from "../Readiness.ts"
import { cmd, type Env, InfraError, type InfraProcess, type InfraTools } from "../Stack.ts"

export const port = (infra: string) => allocatePort.pipe(Effect.mapError((error) => new InfraError({ infra, message: error.message })))

export const DockerSettings = Context.Reference<{ readonly instance: string; readonly reach: string; readonly bind: string }>(
  "forkyard/DockerSettings",
  { defaultValue: () => ({ instance: "", reach: "127.0.0.1", bind: "127.0.0.1" }) }
)

export const dockerSettingsFromEnv = Layer.effect(
  DockerSettings,
  Config.all({
    instance: Config.String("FORKYARD_INSTANCE").pipe(Config.withDefault("")),
    reach: Config.String("FORKYARD_DOCKER_HOST").pipe(Config.withDefault("127.0.0.1")),
    bind: Config.String("FORKYARD_DOCKER_BIND").pipe(Config.withDefault("127.0.0.1"))
  })
)

export const dockerReach = DockerSettings.useSync((settings) => settings.reach)

export const publish = (hostPort: number, containerPort: number) =>
  DockerSettings.useSync((settings) => `${settings.bind}:${hostPort}:${containerPort}`)

export const upperSnake = (name: string) => name.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")

export const forkyardName = (...parts: ReadonlyArray<string | number>) =>
  DockerSettings.useSync((settings) => [settings.instance ? `forkyard-${settings.instance}` : "forkyard", ...parts].join("-"))

export const containerName = (infra: string, instance: string) => forkyardName(infra, instance.replaceAll(/[^a-zA-Z0-9]+/g, "-"))

export const readyOrExit = <A, E, R>(infra: string, started: InfraProcess, check: Effect.Effect<A, E, R>, within: `${number} seconds`) =>
  pollUntilReady(infra, check, { every: "200 millis", within }).pipe(
    unlessItExits(started),
    Effect.mapError((error) => new InfraError({ infra, message: error.message })),
    Effect.withSpan("Shared.readyOrExit", { attributes: { "forkyard.infra": infra } })
  )

export class FetchFailed extends Schema.TaggedError<FetchFailed, { readonly brand: unique symbol }>()("FetchFailed", {
  url: Schema.String,
  message: Schema.String
}) {}

export const fetchOk = (url: string) =>
  Effect.tryPromise({
    try: (signal) => fetch(url, { signal }).then((response) => (response.ok ? response : Promise.reject(new Error(`${response.status}`)))),
    catch: (cause) => new FetchFailed({ url, message: cause instanceof Error ? cause.message : String(cause) })
  })

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
