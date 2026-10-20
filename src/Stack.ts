import { Context, type Duration, Effect, Ref, Schema, type Scope } from "effect"
import type { EnvSource } from "./EnvSource.ts"
import type { InputsHook } from "./Inputs.ts"
import {
  type AbsolutePath,
  type BranchSlug,
  type InfraName,
  type Pid,
  type Port,
  ProjectName,
  ServiceName,
  type WorktreeId
} from "./Ids.ts"

export type Worktree = {
  readonly id: WorktreeId
  readonly project: ProjectName
  readonly branch: BranchSlug
  readonly root: AbsolutePath
  readonly profile: string
  readonly domain: string
  readonly proxyPort: Port
}

export type Command = {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export type ShellScript = { readonly shell: string }

export type Run = Command | ShellScript

export type Env = Readonly<Record<string, string>>

export class InfraError extends Schema.TaggedError<InfraError>()("InfraError", {
  infra: Schema.String,
  message: Schema.String
}) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String
}) {}

export type InfraProcess = {
  readonly pid: Pid
  readonly exited: Effect.Effect<number>
  readonly output: Effect.Effect<ReadonlyArray<string>>
}

export type InfraTools = {
  readonly spawn: (options: {
    readonly name: string
    readonly run: Run
    readonly env: Env
    readonly cwd?: string
  }) => Effect.Effect<InfraProcess, InfraError, Scope.Scope>
  readonly exec: (options: {
    readonly name: string
    readonly run: Run
    readonly env: Env
    readonly cwd: string
  }) => Effect.Effect<string, InfraError, Scope.Scope>
}

export type InfraStarted = {
  readonly port: Port | undefined
  readonly env: Env
  readonly routes: Readonly<Record<string, Port>>
}

export type InfraServer = InfraStarted & {
  readonly instance: string
  readonly urls: Readonly<Record<string, string>>
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export type InfraAction = (server: InfraServer, worktree: Worktree, tools: InfraTools) => Effect.Effect<string, InfraError, Scope.Scope>

export type InfraSpec = {
  readonly name: InfraName
  readonly scope: "worktree" | "shared"
  readonly sharedBy?: "machine" | "project"
  readonly variant?: string
  readonly uses?: ReadonlyArray<InfraSpec>
  readonly actions?: Readonly<Record<string, InfraAction>>
  readonly start: (
    instance: string,
    tools: InfraTools,
    origin: Worktree,
    usesEnv: Env
  ) => Effect.Effect<InfraStarted, InfraError, Scope.Scope>
  readonly tenant: (server: InfraServer, worktree: Worktree, tools: InfraTools) => Effect.Effect<Env, InfraError, Scope.Scope>
}

export type Exposure = { readonly _tag: "Routed"; readonly health: string } | { readonly _tag: "Internal" }

export type Readiness = { readonly _tag: "Started" } | { readonly _tag: "Healthy" } | { readonly _tag: "LogLine"; readonly pattern: RegExp }

export type OnExit = "restart" | "restart-on-failure" | "stop"

export type Watch = { readonly globs: ReadonlyArray<string>; readonly debounce: Duration.Input }

export type Lifecycle =
  | { readonly _tag: "LongRunning"; readonly ready: Readiness; readonly onExit: OnExit; readonly watch: Watch | undefined }
  | { readonly _tag: "RunOnce"; readonly watch: Watch | undefined }

export type ServiceNode = {
  readonly _tag: "Service"
  readonly name: ServiceName
  readonly run: Run
  readonly cwd: string
  readonly env: Env
  readonly envFrom: ReadonlyArray<EnvSource>
  readonly uses: ReadonlyArray<InfraName>
  readonly after: ReadonlyArray<ServiceName>
  readonly calls: ReadonlyArray<ServiceName>
  readonly ports: ReadonlyArray<string>
  readonly links: ReadonlyArray<string>
  readonly stopTimeout?: Duration.Input
  readonly exposure: Exposure
  readonly lifecycle: Lifecycle
}

export type InfraNode = {
  readonly _tag: "Infra"
  readonly spec: InfraSpec
}

export type Node = ServiceNode | InfraNode

export const hostOf = (worktree: Worktree, name: string) => `${name}.${worktree.domain}`

export const proxiedUrl = (host: string, proxyPort: Port) => `http://${host}${proxyPort === 80 ? "" : `:${proxyPort}`}`

export const urlOf = (worktree: Worktree, name: string) => proxiedUrl(hostOf(worktree, name), worktree.proxyPort)

export class CurrentWorktree extends Context.Service<CurrentWorktree, Worktree>()("forkyard/Stack/CurrentWorktree") {}

export class StackBuilder extends Context.Service<
  StackBuilder,
  {
    readonly add: (node: Node) => Effect.Effect<void>
  }
>()("forkyard/Stack/StackBuilder") {}

export type InfraRef = { readonly infra: InfraName }

export type ServiceRef = { readonly service: ServiceName; readonly url: string }

type CommonProps = {
  readonly run: string | Run
  readonly cwd?: string
  readonly env?: Env
  readonly envFrom?: ReadonlyArray<EnvSource>
  readonly uses?: ReadonlyArray<InfraRef>
  readonly after?: ReadonlyArray<ServiceRef>
  readonly calls?: ReadonlyArray<ServiceRef>
  readonly ports?: ReadonlyArray<string>
  readonly links?: ReadonlyArray<string>
  readonly stopTimeout?: Duration.Input
}

type HttpProps = CommonProps & { readonly health?: string; readonly onExit?: OnExit; readonly watch?: Watch }

type WorkerProps = CommonProps & { readonly ready?: "started" | Readiness; readonly onExit?: OnExit; readonly watch?: Watch }

type TaskProps = CommonProps & { readonly watch?: Watch }

type ProcessProps = CommonProps & {
  readonly route?: boolean
  readonly health?: string
  readonly ready?: "started" | "healthy" | "exited" | Readiness
  readonly onExit?: OnExit
  readonly watch?: Watch
}

export const shell = (script: string): Run => ({ shell: script })

export const toRun = (run: string | Run): Run => (typeof run === "string" ? shell(run) : run)

export const logLine = (pattern: RegExp): Readiness => ({ _tag: "LogLine", pattern })

export const watch = (...globs: ReadonlyArray<string>): Watch => ({ globs, debounce: "300 millis" })

const serviceName = (name: string) =>
  ServiceName.makeEffect(name).pipe(
    Effect.mapError(() => new ConfigError({ message: `"${name}" is not a valid service name: use lowercase letters, digits and dashes` }))
  )

const toReadiness = (ready: "started" | "healthy" | Readiness): Readiness => {
  if (ready === "started") return { _tag: "Started" }
  if (ready === "healthy") return { _tag: "Healthy" }
  return ready
}

const invalid = (name: string, problem: string) => new ConfigError({ message: `${name}: ${problem}` })

const runOnceShape = (
  name: string,
  props: ProcessProps
): Effect.Effect<{ readonly exposure: Exposure; readonly lifecycle: Lifecycle }, ConfigError> => {
  if (props.route) return Effect.fail(invalid(name, "a process that runs once cannot have a route"))
  if (props.onExit) return Effect.fail(invalid(name, "a process that runs once has no onExit policy, it is not restarted"))
  return Effect.succeed({ exposure: { _tag: "Internal" }, lifecycle: { _tag: "RunOnce", watch: props.watch } })
}

const longRunningShape = (
  name: string,
  props: ProcessProps,
  requested: "started" | "healthy" | Readiness | undefined
): Effect.Effect<{ readonly exposure: Exposure; readonly lifecycle: Lifecycle }, ConfigError> => {
  const ready = toReadiness(requested ?? (props.route ? "healthy" : "started"))
  const exposure: Exposure = props.route ? { _tag: "Routed", health: props.health ?? "/health" } : { _tag: "Internal" }

  if (ready._tag === "Healthy" && exposure._tag === "Internal") return Effect.fail(invalid(name, "a health check needs a route"))
  return Effect.succeed({ exposure, lifecycle: { _tag: "LongRunning", ready, onExit: props.onExit ?? "restart", watch: props.watch } })
}

const shapeOf = (name: string, props: ProcessProps) =>
  props.ready === "exited" ? runOnceShape(name, props) : longRunningShape(name, props, props.ready)

const declare = Effect.fn("Service.process")(function* (rawName: string, props: ProcessProps) {
  const builder = yield* StackBuilder
  const worktree = yield* CurrentWorktree
  const name = yield* serviceName(rawName)
  const shape = yield* shapeOf(name, props)

  yield* builder.add({
    _tag: "Service",
    name,
    run: toRun(props.run),
    cwd: props.cwd ?? ".",
    env: props.env ?? {},
    envFrom: props.envFrom ?? [],
    uses: (props.uses ?? []).map((ref) => ref.infra),
    after: (props.after ?? []).map((ref) => ref.service),
    calls: (props.calls ?? []).map((ref) => ref.service),
    ports: props.ports ?? [],
    links: props.links ?? [],
    ...(props.stopTimeout ? { stopTimeout: props.stopTimeout } : {}),
    ...shape
  })

  return { service: name, url: urlOf(worktree, name) } satisfies ServiceRef
})

export const Service = {
  process: declare,
  http: (name: string, props: HttpProps) => declare(name, { ...props, route: true, ready: "healthy" }),
  worker: (name: string, props: WorkerProps) => declare(name, { ...props, ready: props.ready ?? "started" }),
  task: (name: string, props: TaskProps) => declare(name, { ...props, ready: "exited" })
}

export const serviceRef = Effect.fn("serviceRef")(function* (rawName: string) {
  const worktree = yield* CurrentWorktree
  const name = yield* serviceName(rawName)

  return { service: name, url: urlOf(worktree, name) } satisfies ServiceRef
})

export const url = (rawName: string) => serviceRef(rawName).pipe(Effect.map((ref) => ref.url))

export const Infra = Effect.fn("Infra")(function* (spec: InfraSpec) {
  const builder = yield* StackBuilder

  yield* builder.add({ _tag: "Infra", spec })

  return { infra: spec.name } satisfies InfraRef
})

type NodeOptions = {
  readonly args?: ReadonlyArray<string>
}

type BunOptions = {
  readonly watch?: boolean
  readonly args?: ReadonlyArray<string>
}

type TsNodeOptions = {
  readonly transpileOnly?: boolean
  readonly require?: ReadonlyArray<string>
  readonly args?: ReadonlyArray<string>
}

const flag = (enabled: boolean | undefined, name: string) => (enabled ? [name] : [])

export const node = (file: string, options: NodeOptions = {}): Command => ({
  command: "node",
  args: [file, ...(options.args ?? [])]
})

export const bun = (file: string, options: BunOptions = {}): Command => ({
  command: "bun",
  args: [...flag(options.watch, "--watch"), file, ...(options.args ?? [])]
})

export const tsNode = (file: string, options: TsNodeOptions = {}): Command => ({
  command: "ts-node",
  args: [
    ...flag(options.transpileOnly ?? true, "--transpile-only"),
    ...(options.require ?? []).flatMap((module) => ["-r", module]),
    file,
    ...(options.args ?? [])
  ]
})

export const cmd = (command: string, ...args: ReadonlyArray<string>): Command => ({ command, args })

export type Stack = {
  readonly name: ProjectName
  readonly profiles: ReadonlyArray<string>
  readonly inputs?: InputsHook
  readonly build: (worktree: Worktree) => Effect.Effect<ReadonlyArray<Node>, ConfigError>
}

export const defaultProfile = "default"

export const profile = CurrentWorktree.useSync((worktree) => worktree.profile)

export const make = (
  name: string,
  program: Effect.Effect<unknown, ConfigError, StackBuilder | CurrentWorktree>,
  options: { readonly profiles?: ReadonlyArray<string>; readonly inputs?: InputsHook } = {}
): Stack => ({
  name: ProjectName.make(name),
  profiles: [defaultProfile, ...(options.profiles ?? []).filter((name) => name !== defaultProfile)],
  ...(options.inputs ? { inputs: options.inputs } : {}),
  build: Effect.fn("Stack.build")(function* (worktree: Worktree) {
    const nodes = yield* Ref.make<ReadonlyArray<Node>>([])
    const builder = StackBuilder.of({ add: (node) => Ref.update(nodes, (all) => [...all, node]) })

    yield* program.pipe(Effect.provideService(StackBuilder, builder), Effect.provideService(CurrentWorktree, worktree))

    return yield* Ref.get(nodes)
  })
})
