import { NodeChildProcessSpawner } from "@effect/platform-node"
import { Clock, Context, Effect, Layer, Logger, Metric, Schema, type Scope, Stream } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { OtlpExporter, OtlpLogger, OtlpSerialization } from "effect/observability"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Metrics from "./Metrics.ts"
import { Registry } from "./Registry.ts"
import { Runs } from "./Runs.ts"
import type { Env, Run } from "./Stack.ts"
import { Status } from "./Status.ts"

export class SpawnError extends Schema.TaggedError<SpawnError>()("SpawnError", {
  service: Schema.String,
  message: Schema.String
}) {}

declare const ownedByScope: unique symbol

export type Spawned = {
  readonly [ownedByScope]: true
  readonly pid: number
  readonly runId: number
  readonly run: number
  readonly exited: Effect.Effect<number>
  readonly output: Effect.Effect<ReadonlyArray<string>>
}

const mint = (handle: Omit<Spawned, typeof ownedByScope>): Spawned => handle as unknown as Spawned

export type SpawnOptions = {
  readonly worktree: string
  readonly service: string
  readonly run: Run
  readonly env: Env
  readonly cwd: string
  readonly telemetry?: {
    readonly namespace: string
    readonly attributes: Readonly<Record<string, string>>
  }
}

const commandLine = (run: Run) => [run.command.split("/").at(-1) ?? run.command, ...run.args].join(" ")

const tail = (text: string) => text.trim().split("\n").slice(-6).join("\n")

const lines = (stream: Stream.Stream<Uint8Array, unknown>, iostream: "stdout" | "stderr") =>
  stream.pipe(Stream.decodeText(), Stream.splitLines, Stream.map((line) => ({ line, iostream })))

export class Proc extends Context.Service<Proc, {
  readonly spawn: (options: SpawnOptions) => Effect.Effect<Spawned, SpawnError, Scope.Scope>
  readonly exec: (options: SpawnOptions) => Effect.Effect<string, SpawnError, Scope.Scope>
}>()("forkyard/Proc") {
  static readonly layer = (options: { readonly otlpUrl: string }) =>
    Layer.effect(
      Proc,
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const registry = yield* Registry
        const runs = yield* Runs
        const status = yield* Status
        const exportContext = yield* Effect.context<OtlpExporter.Flusher | OtlpSerialization.OtlpSerialization | HttpClient.HttpClient>()

        const start = (spawn: SpawnOptions) =>
          spawner
            .spawn(
              ChildProcess.make(spawn.run.command, [...spawn.run.args], {
                cwd: spawn.cwd,
                env: spawn.env,
                extendEnv: true,
                detached: true,
                killSignal: "SIGTERM",
                forceKillAfter: "3 seconds"
              })
            )
            .pipe(Effect.mapError((error) => new SpawnError({ service: spawn.service, message: error.message })))

        const processLogger = (spawn: SpawnOptions, pid: number, run: number) =>
          OtlpLogger.make({
            url: `${options.otlpUrl}/v1/logs`,
            resource: {
              serviceName: spawn.service,
              attributes: {
                "service.namespace": spawn.telemetry?.namespace ?? spawn.worktree,
                "service.instance.id": `${spawn.worktree}/${spawn.service}#${run}`,
                "process.pid": pid,
                "process.command_line": commandLine(spawn.run),
                "forkyard.run": run,
                ...spawn.telemetry?.attributes
              }
            },
            excludeLogSpans: true
          }).pipe(Effect.provide(exportContext))

        const spawn = Effect.fn("Proc.spawn")(function*(spawn: SpawnOptions) {
          const attributes = {
            "forkyard.worktree": spawn.worktree,
            "forkyard.service": spawn.service,
            "process.command_line": commandLine(spawn.run),
            "process.working_directory": spawn.cwd
          }
          yield* Effect.annotateCurrentSpan(attributes)
          const handle = yield* start(spawn)
          const pid = Number(handle.pid)
          yield* Effect.annotateCurrentSpan({ "process.pid": pid })
          yield* registry.track({ pid, worktree: spawn.worktree, service: spawn.service })
          const run = yield* runs.begin({ worktree: spawn.worktree, service: spawn.service, pid, command: commandLine(spawn.run) })
          const runSpan = yield* Effect.makeSpanScoped(`${spawn.service} run #${run.n}`, {
            attributes: { ...attributes, "process.pid": pid, "forkyard.run": run.n, "forkyard.run_id": run.id },
            kind: "internal"
          })
          yield* Metric.update(Metric.withAttributes(Metrics.processStarts, { "forkyard.service": spawn.service, "forkyard.worktree": spawn.worktree }), 1)

          const exportsLogs = spawn.telemetry !== undefined
          const childLogger = exportsLogs ? yield* processLogger(spawn, pid, run.n) : undefined
          const forward = (entry: { readonly line: string; readonly iostream: "stdout" | "stderr" }) =>
            childLogger
              ? Effect.logInfo(entry.line).pipe(
                Effect.annotateLogs({ "log.iostream": entry.iostream }),
                Effect.provideService(Logger.CurrentLoggers, new Set([childLogger]))
              )
              : Effect.void

          yield* Stream.merge(lines(handle.stdout, "stdout"), lines(handle.stderr, "stderr")).pipe(
            Stream.zipWithIndex,
            Stream.mapEffect(([entry, seq]) =>
              Clock.currentTimeMillis.pipe(Effect.map((at) => ({ entry, record: { runId: run.id, seq, at, line: entry.line } })))
            ),
            Stream.tap(({ entry, record }) =>
              Effect.all([status.log({ ...record, worktree: spawn.worktree, service: spawn.service }), forward(entry)], { discard: true })
            ),
            Stream.map(({ record }) => record),
            Stream.groupedWithin(200, "250 millis"),
            Stream.runForEach((batch) =>
              runs.append(batch).pipe(Effect.andThen(Metric.update(Metrics.logLines, batch.length)))
            ),
            Effect.ignore,
            Effect.withParentSpan(runSpan),
            Effect.withTracerEnabled(false),
            Effect.forkScoped
          )

          return mint({
            pid,
            runId: run.id,
            run: run.n,
            output: runs.lines(run.id).pipe(Effect.map((lines) => lines.slice(-12).map((line) => line.line))),
            exited: handle.exitCode.pipe(
              Effect.map(Number),
              Effect.orElseSucceed(() => -1),
              Effect.tap((code) =>
                Effect.all([
                  runs.exited(run.id, code),
                  Effect.sync(() => runSpan.attribute("process.exit_code", code)),
                  Metric.update(Metric.withAttributes(Metrics.processExits, { "forkyard.service": spawn.service, "process.exit_code": String(code) }), 1)
                ], { discard: true })
              )
            )
          })
        })

        const exec = Effect.fn("Proc.exec")(function*(spawn: SpawnOptions) {
          yield* Effect.annotateCurrentSpan({ "forkyard.worktree": spawn.worktree, "forkyard.service": spawn.service, "process.command_line": commandLine(spawn.run) })
          const handle = yield* start(spawn)
          yield* registry.track({ pid: Number(handle.pid), worktree: spawn.worktree, service: spawn.service })
          const collect = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString, Effect.orElseSucceed(() => ""))
          const [stdout, stderr, code] = yield* Effect.all(
            [collect(handle.stdout), collect(handle.stderr), handle.exitCode.pipe(Effect.map(Number), Effect.orElseSucceed(() => -1))],
            { concurrency: "unbounded" }
          )
          yield* Effect.annotateCurrentSpan({ "process.exit_code": code })
          if (code !== 0) {
            return yield* new SpawnError({ service: spawn.service, message: `${commandLine(spawn.run)} exited ${code}: ${tail(stderr || stdout)}` })
          }
          return stdout
        })

        return Proc.of({ spawn, exec })
      })
    ).pipe(
      Layer.provide(NodeChildProcessSpawner.layer),
      Layer.provide(OtlpExporter.layerFlusher),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer)
    )
}
