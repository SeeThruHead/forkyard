import { Context, Effect, Ref, Schema, type Scope } from "effect"
import type { EnvSource } from "./EnvSource.ts"
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
  readonly domain: string
  readonly proxyPort: Port
}

export type Run = {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

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

export type InfraSpec = {
  readonly name: InfraName
  readonly scope: "worktree" | "shared"
  readonly start: (instance: string, tools: InfraTools) => Effect.Effect<InfraStarted, InfraError, Scope.Scope>
  readonly tenant: (server: InfraServer, worktree: Worktree, tools: InfraTools) => Effect.Effect<Env, InfraError, Scope.Scope>
}

export type ServiceKind = "http" | "worker" | "task"

export type ServiceNode = {
  readonly _tag: "Service"
  readonly name: ServiceName
  readonly kind: ServiceKind
  readonly run: Run
  readonly cwd: string
  readonly env: Env
  readonly envFrom: ReadonlyArray<EnvSource>
  readonly uses: ReadonlyArray<InfraName>
  readonly after: ReadonlyArray<ServiceName>
  readonly health: string
}

export type InfraNode = {
  readonly _tag: "Infra"
  readonly spec: InfraSpec
}

export type Node = ServiceNode | InfraNode

export const hostOf = (worktree: Worktree, name: string) => `${name}.${worktree.domain}`

export const urlOf = (worktree: Worktree, name: string) =>
  `http://${hostOf(worktree, name)}${worktree.proxyPort === 80 ? "" : `:${worktree.proxyPort}`}`

export class CurrentWorktree extends Context.Service<CurrentWorktree, Worktree>()("forkyard/Stack/CurrentWorktree") {}

export class StackBuilder extends Context.Service<
  StackBuilder,
  {
    readonly add: (node: Node) => Effect.Effect<void>
  }
>()("forkyard/Stack/StackBuilder") {}

export type InfraRef = { readonly infra: InfraName }

export type ServiceRef = { readonly service: ServiceName; readonly url: string }

type ServiceProps = {
  readonly run: Run
  readonly cwd?: string
  readonly env?: Env
  readonly envFrom?: ReadonlyArray<EnvSource>
  readonly uses?: ReadonlyArray<InfraRef>
  readonly after?: ReadonlyArray<ServiceRef>
  readonly health?: string
}

const serviceName = (name: string) =>
  ServiceName.makeEffect(name).pipe(
    Effect.mapError(() => new ConfigError({ message: `"${name}" is not a valid service name: use lowercase letters, digits and dashes` }))
  )

const serviceNode = (kind: ServiceKind, name: ServiceName, props: ServiceProps): ServiceNode => ({
  _tag: "Service",
  name,
  kind,
  run: props.run,
  cwd: props.cwd ?? ".",
  env: props.env ?? {},
  envFrom: props.envFrom ?? [],
  uses: (props.uses ?? []).map((ref) => ref.infra),
  after: (props.after ?? []).map((ref) => ref.service),
  health: props.health ?? "/health"
})

const declare = (kind: ServiceKind) =>
  Effect.fn(`Service.${kind}`)(function* (rawName: string, props: ServiceProps) {
    const builder = yield* StackBuilder
    const worktree = yield* CurrentWorktree
    const name = yield* serviceName(rawName)

    yield* builder.add(serviceNode(kind, name, props))

    return { service: name, url: urlOf(worktree, name) } satisfies ServiceRef
  })

export const Service = {
  http: declare("http"),
  worker: declare("worker"),
  task: declare("task")
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

export const node = (script: string, ...args: ReadonlyArray<string>): Run => ({
  command: process.execPath,
  args: [script, ...args]
})

export const cmd = (command: string, ...args: ReadonlyArray<string>): Run => ({ command, args })

export type Stack = {
  readonly name: ProjectName
  readonly build: (worktree: Worktree) => Effect.Effect<ReadonlyArray<Node>, ConfigError>
}

export const make = (name: string, program: Effect.Effect<unknown, ConfigError, StackBuilder | CurrentWorktree>): Stack => ({
  name: ProjectName.make(name),
  build: Effect.fn("Stack.build")(function* (worktree: Worktree) {
    const nodes = yield* Ref.make<ReadonlyArray<Node>>([])
    const builder = StackBuilder.of({ add: (node) => Ref.update(nodes, (all) => [...all, node]) })

    yield* program.pipe(Effect.provideService(StackBuilder, builder), Effect.provideService(CurrentWorktree, worktree))

    return yield* Ref.get(nodes)
  })
})
