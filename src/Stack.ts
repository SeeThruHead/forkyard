import { Context, Effect, Ref, Schema, type Scope } from "effect"
import type { EnvSource } from "./EnvSource.ts"

export type Worktree = {
  readonly id: string
  readonly project: string
  readonly branch: string
  readonly root: string
  readonly domain: string
  readonly proxyPort: number
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

export type InfraProcess = {
  readonly pid: number
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
  readonly port: number
  readonly env: Env
  readonly routes: Readonly<Record<string, number>>
}

export type InfraServer = InfraStarted & {
  readonly instance: string
  readonly urls: Readonly<Record<string, string>>
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export type InfraSpec = {
  readonly name: string
  readonly scope: "worktree" | "shared"
  readonly start: (instance: string, tools: InfraTools) => Effect.Effect<InfraStarted, InfraError, Scope.Scope>
  readonly tenant: (server: InfraServer, worktree: Worktree, tools: InfraTools) => Effect.Effect<Env, InfraError, Scope.Scope>
}

export type ServiceNode = {
  readonly _tag: "Service"
  readonly name: string
  readonly kind: "http" | "worker" | "task"
  readonly run: Run
  readonly cwd: string
  readonly env: Env
  readonly envFrom: ReadonlyArray<EnvSource>
  readonly uses: ReadonlyArray<string>
  readonly after: ReadonlyArray<string>
  readonly health: string | undefined
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

export class StackBuilder extends Context.Service<StackBuilder, {
  readonly add: (node: Node) => Effect.Effect<void>
}>()("forkyard/Stack/StackBuilder") {}

export type InfraRef = { readonly infra: string }

export type ServiceRef = { readonly service: string; readonly url: string }

type ServiceProps = {
  readonly run: Run
  readonly cwd?: string
  readonly env?: Env
  readonly envFrom?: ReadonlyArray<EnvSource>
  readonly uses?: ReadonlyArray<InfraRef>
  readonly after?: ReadonlyArray<ServiceRef>
  readonly health?: string
}

const declare = (kind: ServiceNode["kind"]) =>
  Effect.fn(`Service.${kind}`)(function*(name: string, props: ServiceProps) {
    const builder = yield* StackBuilder
    const worktree = yield* CurrentWorktree
    yield* builder.add({
      _tag: "Service",
      name,
      kind,
      run: props.run,
      cwd: props.cwd ?? ".",
      env: props.env ?? {},
      envFrom: props.envFrom ?? [],
      uses: (props.uses ?? []).map((ref) => ref.infra),
      after: (props.after ?? []).map((ref) => ref.service),
      health: props.health
    })
    return { service: name, url: urlOf(worktree, name) } satisfies ServiceRef
  })

export const Service = {
  http: declare("http"),
  worker: declare("worker"),
  task: declare("task")
}

export const url = Effect.fn("url")(function*(name: string) {
  return urlOf(yield* CurrentWorktree, name)
})

export const Infra = Effect.fn("Infra")(function*(spec: InfraSpec) {
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
  readonly name: string
  readonly build: (worktree: Worktree) => Effect.Effect<ReadonlyArray<Node>>
}

export const make = (
  name: string,
  program: Effect.Effect<unknown, never, StackBuilder | CurrentWorktree>
): Stack => ({
  name,
  build: Effect.fn("Stack.build")(function*(worktree: Worktree) {
    const nodes = yield* Ref.make<ReadonlyArray<Node>>([])
    yield* program.pipe(
      Effect.provideService(StackBuilder, StackBuilder.of({ add: (node) => Ref.update(nodes, (all) => [...all, node]) })),
      Effect.provideService(CurrentWorktree, worktree)
    )
    return yield* Ref.get(nodes)
  })
})
