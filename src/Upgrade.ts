import { Context, Deferred, Effect, FileSystem, Layer, Ref, Schedule, Schema } from "effect"
import { fromPackage, packageVersion } from "./Package.ts"

const InstalledPackage = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

export class Upgrade extends Context.Service<
  Upgrade,
  {
    readonly pending: Effect.Effect<string | undefined>
    readonly restartRequested: Effect.Effect<void>
  }
>()("forkyard/Upgrade") {
  static readonly layer = (options: { readonly supervised: boolean }) =>
    Layer.effect(
      Upgrade,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pending = yield* Ref.make<string | undefined>(undefined)
        const restart = yield* Deferred.make<void>()

        const installedVersion = fs.readFileString(fromPackage("package.json")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(InstalledPackage)),
          Effect.map((pkg) => pkg.version),
          Effect.orElseSucceed(() => packageVersion)
        )

        const notice = Effect.fn("Upgrade.notice")(function* (installed: string) {
          if ((yield* Ref.get(pending)) === installed) return
          yield* Ref.set(pending, installed)
          if (!options.supervised) {
            yield* Effect.logWarning(`forkyard ${installed} is installed; this daemon is still ${packageVersion}. Restart it to upgrade.`)
            return
          }
          yield* Effect.logWarning(`forkyard ${installed} is installed; restarting from ${packageVersion} to switch to it`)
          yield* Deferred.succeed(restart, undefined)
        })

        const check = installedVersion.pipe(Effect.flatMap((installed) => (installed === packageVersion ? Effect.void : notice(installed))))

        yield* check.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped)

        return Upgrade.of({ pending: Ref.get(pending), restartRequested: Deferred.await(restart) })
      })
    )
}
