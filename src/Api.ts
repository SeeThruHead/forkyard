import { Effect, FileSystem, Option, Path, Record, Stream } from "effect"
import { DaemonLog } from "./DaemonLog.ts"
import { cliPath, packageVersion, protocolVersion } from "./Package.ts"
import { Upgrade } from "./Upgrade.ts"
import { ProcessUsage } from "./Usage.ts"
import { EnvResolver } from "./Env.ts"
import { AbsolutePath, ownerOfWorktree, type RunId } from "./Ids.ts"
import { InfraManager } from "./InfraManager.ts"
import { ForkyardError, ForkyardRpcs } from "./Protocol.ts"
import { Router } from "./Router.ts"
import { Runs } from "./Runs.ts"
import { findStackFile } from "./StackFile.ts"
import { Status } from "./Status.ts"
import { Supervisor } from "./Supervisor.ts"
import { Worktrees } from "./Worktrees.ts"

export const layer = (options: { readonly dashboardUrl: string }) =>
  ForkyardRpcs.toLayer(
    Effect.gen(function* () {
      const worktrees = yield* Worktrees
      const supervisor = yield* Supervisor
      const status = yield* Status
      const runs = yield* Runs
      const router = yield* Router
      const infra = yield* InfraManager
      const env = yield* EnvResolver
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const daemonLog = yield* DaemonLog
      const usage = yield* ProcessUsage
      const upgrade = yield* Upgrade

      const runLogSource = Effect.fn("Api.runLog")(function* (runId: RunId) {
        const following = yield* status.followLogs
        const history = yield* runs.lines(runId)
        if (yield* runs.ended(runId)) return Stream.fromIterable(history)

        const last = history.at(-1)?.seq ?? -1
        const live = following.pipe(
          Stream.filter((line) => line.runId === runId && line.seq > last),
          Stream.map((line) => ({ runId: line.runId, seq: line.seq, at: line.at, line: line.line }))
        )
        return Stream.fromIterable(history).pipe(Stream.concat(live))
      })

      const runLog = (runId: RunId) => Stream.unwrap(runLogSource(runId))

      const envReport = Effect.fn("Api.env")(function* (id: Parameters<typeof env.report>[0], service: Parameters<typeof env.report>[1]) {
        const report = yield* env.report(id, service)
        if (!report) return yield* new ForkyardError({ message: `${id}/${service} has no resolved env yet` })
        return report
      })

      const stackFileOf = (root: AbsolutePath) =>
        findStackFile(fs, path, root).pipe(Effect.map(Option.getOrElse(() => AbsolutePath.make(path.join(root, "forkyard.config.ts")))))

      const up = Effect.fn("Api.up")(function* (root: AbsolutePath, branch: string, profile: string, requested: AbsolutePath | undefined) {
        const stackFile = requested ?? (yield* stackFileOf(root))
        const id = yield* worktrees.up({ root, branch, profile, stackFile })
        return { id }
      })

      return ForkyardRpcs.of({
        Up: ({ root, branch, profile, stackFile }) => up(root, branch, profile ?? "default", stackFile),
        Down: ({ id }) => worktrees.down(id),
        Status: () => status.changes,
        Logs: ({ id }) => status.logs.pipe(Stream.filter((line) => line.owner === ownerOfWorktree(id))),
        Env: ({ id, service }) => envReport(id, service),
        Restart: ({ id, service }) => supervisor.restart(id, service),
        Own: ({ id, service }) => supervisor.own(id, service),
        Share: ({ id, service }) => supervisor.share(id, service),
        Start: ({ id, service }) => supervisor.start(id, service),
        Stop: ({ id, service }) => supervisor.stop(id, service),
        UpdateShared: ({ id }) =>
          supervisor.updateShared(id).pipe(Effect.mapError((error) => new ForkyardError({ message: error.message }))),
        Runs: ({ owner, service }) => runs.list(owner, service),
        RunLog: ({ runId }) => runLog(runId),
        Routes: () => router.routes.pipe(Effect.map(Record.map((route) => route.port))),
        Infra: () => infra.running,
        DaemonLogs: () => daemonLog.lines,
        Usage: () => usage.changes,
        Info: () =>
          upgrade.pending.pipe(
            Effect.map((pending) => ({
              cli: cliPath,
              dashboard: options.dashboardUrl,
              version: packageVersion,
              protocol: protocolVersion,
              ...(pending ? { pendingVersion: pending } : {})
            }))
          ),
        InfraAction: ({ id, infra: name, action }) =>
          supervisor.infraAction(id, name, action).pipe(Effect.mapError((error) => new ForkyardError({ message: error.message })))
      })
    })
  )
