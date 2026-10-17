import { Effect, Option, Schema } from "effect"
import { Env } from "forkyard"

const Store = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))

const storeFile = "tools/fake-secrets/secrets.json"

const failure = (secret: string) => (error: { readonly message: string }) => new Env.EnvError({ source: secret, message: error.message })

export const secretsStore = (options: { readonly secret: string; readonly pick: ReadonlyArray<string> }): Env.EnvSource => ({
  label: `secrets ${options.secret}`,
  load: Effect.fn("secretsStore.load")(function* (context: Env.EnvLoadContext) {
    const text = yield* context.readFile(`${context.root}/${storeFile}`)
    if (Option.isNone(text)) return yield* new Env.EnvError({ source: options.secret, message: `${storeFile} not found` })

    const store = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Store))(text.value).pipe(Effect.mapError(failure(options.secret)))
    const values = store[options.secret] ?? {}

    return Object.fromEntries(
      options.pick.flatMap((key) => {
        const value = values[key]
        return value === undefined ? [] : [[key, { value, sensitive: true }] as const]
      })
    )
  })
})
