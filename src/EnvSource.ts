import { Effect, Option, Schema, type Scope } from "effect"
import { parseEnv } from "node:util"
import type { Env, Run } from "./Stack.ts"

export class EnvError extends Schema.TaggedError<EnvError>()("EnvError", {
  source: Schema.String,
  message: Schema.String
}) {}

export type EnvEntry = {
  readonly value: string
  readonly sensitive: boolean
}

export type EnvLoadContext = {
  readonly root: string
  readonly cwd: string
  readonly overrides: Env
  readonly exec: (run: Run, cwd: string) => Effect.Effect<string, EnvError, Scope.Scope>
  readonly readFile: (path: string) => Effect.Effect<Option.Option<string>, EnvError>
}

export type EnvSource = {
  readonly label: string
  readonly load: (context: EnvLoadContext) => Effect.Effect<Readonly<Record<string, EnvEntry>>, EnvError, Scope.Scope>
}

export const looksSensitive = (key: string) => /SECRET|PASSWORD|TOKEN|PRIVATE|_KEY$/.test(key)

const entriesOf = (values: Readonly<Record<string, unknown>>): Readonly<Record<string, EnvEntry>> =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, { value: String(value), sensitive: looksSensitive(key) }])
  )

export const dotenv = (...files: ReadonlyArray<string>): EnvSource => ({
  label: files.join(" + "),
  load: (context) =>
    Effect.forEach(files, (file) =>
      context
        .readFile(`${context.root}/${file}`)
        .pipe(Effect.map(Option.match({ onNone: () => ({}), onSome: (text) => entriesOf(parseEnv(text)) })))
    ).pipe(Effect.map((all) => all.reduce((merged, next) => ({ ...merged, ...next }), {})))
})

const VarlockOutput = Schema.Struct({
  config: Schema.Record(Schema.String, Schema.Struct({ value: Schema.optional(Schema.Unknown), isSensitive: Schema.Boolean }))
})

const varlockCommand = Effect.fnUntraced(function* (context: EnvLoadContext, root: string, run: Run | undefined) {
  if (run) return run

  const local = `${root}/node_modules/.bin/varlock`
  const installed = yield* context.readFile(local)
  return Option.isSome(installed) ? { command: local, args: [] } : { command: "pnpm", args: ["exec", "varlock"] }
})

export const varlock = (options: { readonly run?: Run; readonly path?: string; readonly schema?: string } = {}): EnvSource => ({
  label: options.schema ? `varlock ${options.schema}` : "varlock",
  load: Effect.fn("EnvSource.varlock")(function* (context: EnvLoadContext) {
    const root = options.path ? `${context.root}/${options.path}` : context.root
    const run = yield* varlockCommand(context, root, options.run)
    const entry = options.schema ? ["--path", `${context.root}/${options.schema}`] : []
    const json = yield* context.exec({ command: run.command, args: [...run.args, "load", ...entry, "--format", "json-full"] }, root)
    const output = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(VarlockOutput))(json).pipe(
      Effect.mapError((error) => new EnvError({ source: "varlock", message: error.message }))
    )

    return Object.fromEntries(
      Object.entries(output.config)
        .filter(([, item]) => item.value !== undefined && item.value !== null)
        .map(([key, item]) => [key, { value: String(item.value), sensitive: item.isSensitive }])
    )
  })
})

const ComposeConfig = Schema.Struct({
  services: Schema.Record(
    Schema.String,
    Schema.Struct({ environment: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))) })
  )
})

export const compose = (options: { readonly service: string; readonly file?: string }): EnvSource => ({
  label: `compose:${options.service}`,
  load: Effect.fn("EnvSource.compose")(function* (context: EnvLoadContext) {
    const file = options.file ?? "docker-compose.yml"
    const json = yield* context.exec({ command: "docker", args: ["compose", "-f", file, "config", "--format", "json"] }, context.root)
    const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ComposeConfig))(json).pipe(
      Effect.mapError((error) => new EnvError({ source: "compose", message: error.message }))
    )
    const service = config.services[options.service]
    if (!service) return yield* new EnvError({ source: "compose", message: `no service ${options.service} in ${file}` })
    return entriesOf(service.environment ?? {})
  })
})
