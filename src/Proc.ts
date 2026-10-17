import { NodeChildProcessSpawner } from "@effect/platform-node"
import { Clock, Context, Deferred, Effect, Layer, Logger, Metric, Schema, type Scope, Stream, type Tracer } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { OtlpExporter, OtlpLogger, OtlpSerialization } from "effect/observability"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pid, type ProcessOwner } from "./Ids.ts"
import * as Metrics from "./Metrics.ts"
import type { RunInfo, RunLine, RunRef } from "./Model.ts"
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
  readonly pid: Pid
  readonly run: RunRef
  readonly exited: Effect.Effect<number>
  readonly output: Effect.Effect<ReadonlyArray<string>>
  readonly logged: Effect.Effect<void>
}

const mint = (handle: Omit<Spawned, typeof ownedByScope>): Spawned => handle as unknown as Spawned

export type SpawnOptions = {
  readonly owner: ProcessOwner
  readonly service: string
  readonly run: Run
  readonly env: Env
  readonly cwd: string
  readonly readyLine?: RegExp
  readonly telemetry?: {
    readonly namespace: string
    readonly attributes: Readonly<Record<string, string>>
  }
}

type OutputLine = { readonly line: string; readonly iostream: "stdout" | "stderr" }

type Handle = ChildProcessSpawner.ChildProcessHandle

const commandLine = (run: Run) => [run.command.split("/").at(-1) ?? run.command, ...run.args].join(" ")

const lastLines = (text: string) => text.trim().split("\n").slice(-6).join("\n")

const lines = (stream: Stream.Stream<Uint8Array, unknown>, iostream: OutputLine["iostream"]) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map((line): OutputLine => ({ line, iostream }))
  )

const processAttributes = (options: SpawnOptions) => ({
  "forkyard.owner": options.owner,
  "forkyard.service": options.service,
  "process.command_line": commandLine(options.run),
  "process.working_directory": options.cwd
})

const runRef = (info: RunInfo): RunRef => ({ runId: info.id, run: info.n, pid: info.pid })

const exitCodeOf = (handle: Handle) =>
  handle.exitCode.pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => -1)
  )

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => "")
  )

export class Proc extends Context.Service<
  Proc,
  {
    readonly spawn: (options: SpawnOptions) => Effect.Effect<Spawned, SpawnError, Scope.Scope>
    readonly exec: (options: SpawnOptions) => Effect.Effect<string, SpawnError, Scope.Scope>
    readonly processTable: Effect.Effect<string>
  }
>()("forkyard/Proc") {
  static readonly layer = (options: { readonly otlpUrl: string | undefined }) =>
    Layer.effect(
      Proc,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const registry = yield* Registry
        const runs = yield* Runs
        const status = yield* Status
        const exportContext = yield* Effect.context<OtlpExporter.Flusher | OtlpSerialization.OtlpSerialization | HttpClient.HttpClient>()

        const launch = (spawn: SpawnOptions) =>
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

        const recordRun = Effect.fnUntraced(function* (spawn: SpawnOptions, pid: Pid) {
          yield* registry.track({ pid, owner: spawn.owner, service: spawn.service })

          return yield* runs.begin({ owner: spawn.owner, service: spawn.service, pid, command: commandLine(spawn.run) })
        })

        const lifetimeSpan = (spawn: SpawnOptions, run: RunInfo) =>
          Effect.makeSpanScoped(`${spawn.service} run #${run.n}`, {
            attributes: { ...processAttributes(spawn), "process.pid": run.pid, "forkyard.run": run.n, "forkyard.run_id": run.id },
            kind: "internal"
          })

        const processLogger = (spawn: SpawnOptions, run: RunInfo, otlpUrl: string) =>
          OtlpLogger.make({
            url: `${otlpUrl}/v1/logs`,
            resource: {
              serviceName: spawn.service,
              attributes: {
                "service.namespace": spawn.telemetry?.namespace ?? spawn.owner,
                "service.instance.id": `${spawn.owner}/${spawn.service}#${run.n}`,
                "process.pid": run.pid,
                "process.command_line": commandLine(spawn.run),
                "forkyard.run": run.n,
                ...spawn.telemetry?.attributes
              }
            },
            excludeLogSpans: true
          }).pipe(Effect.provide(exportContext))

        const exportLine = (logger: Logger.Logger<unknown, void> | undefined) => (entry: OutputLine) =>
          logger
            ? Effect.logInfo(entry.line).pipe(
                Effect.annotateLogs({ "log.iostream": entry.iostream }),
                Effect.provideService(Logger.CurrentLoggers, new Set([logger]))
              )
            : Effect.void

        const numbered =
          (run: RunInfo) =>
          ([entry, seq]: readonly [OutputLine, number]) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((at) => ({ entry, record: { runId: run.id, seq, at, line: entry.line } satisfies RunLine }))
            )

        const persist = (batch: ReadonlyArray<RunLine>) =>
          runs.append(batch).pipe(Effect.andThen(Metric.update(Metrics.logLines, batch.length)))

        const outputPipeline = (
          spawn: SpawnOptions,
          handle: Handle,
          run: RunInfo,
          publish: (line: { readonly entry: OutputLine; readonly record: RunLine }) => Effect.Effect<void>
        ) =>
          Stream.merge(lines(handle.stdout, "stdout"), lines(handle.stderr, "stderr")).pipe(
            Stream.zipWithIndex,
            Stream.mapEffect(numbered(run)),
            Stream.tap(publish),
            Stream.map(({ record }) => record),
            Stream.groupedWithin(200, "250 millis"),
            Stream.runForEach(persist),
            Effect.ignore
          )

        const signalReadyLine = (spawn: SpawnOptions, logged: Deferred.Deferred<void>) => (entry: OutputLine) =>
          spawn.readyLine?.test(entry.line) ? Deferred.succeed(logged, undefined) : Effect.void

        const forwardOutput = Effect.fnUntraced(function* (
          spawn: SpawnOptions,
          handle: Handle,
          run: RunInfo,
          span: Tracer.Span,
          logged: Deferred.Deferred<void>
        ) {
          const logger = spawn.telemetry && options.otlpUrl ? yield* processLogger(spawn, run, options.otlpUrl) : undefined
          const exported = exportLine(logger)
          const readyCheck = signalReadyLine(spawn, logged)
          const publish = ({ entry, record }: { readonly entry: OutputLine; readonly record: RunLine }) =>
            Effect.all([status.log({ ...record, owner: spawn.owner, service: spawn.service }), exported(entry), readyCheck(entry)], {
              discard: true
            })

          yield* outputPipeline(spawn, handle, run, publish).pipe(
            Effect.withParentSpan(span),
            Effect.withTracerEnabled(false),
            Effect.forkScoped
          )
        })

        const recordExit = (spawn: SpawnOptions, run: RunInfo, span: Tracer.Span) => (code: number) =>
          Effect.all(
            [
              runs.exited(run.id, code),
              Effect.sync(() => span.attribute("process.exit_code", code)),
              Metric.update(
                Metric.withAttributes(Metrics.processExits, { "forkyard.service": spawn.service, "process.exit_code": String(code) }),
                1
              )
            ],
            { discard: true }
          )

        const exitOf = (spawn: SpawnOptions, handle: Handle, run: RunInfo, span: Tracer.Span) =>
          exitCodeOf(handle).pipe(Effect.tap(recordExit(spawn, run, span)))

        const recentOutput = (run: RunInfo) => runs.lines(run.id).pipe(Effect.map((all) => all.slice(-12).map((line) => line.line)))

        const countStart = (spawn: SpawnOptions) =>
          Metric.update(
            Metric.withAttributes(Metrics.processStarts, { "forkyard.service": spawn.service, "forkyard.owner": spawn.owner }),
            1
          )

        const spawn = Effect.fn("Proc.spawn")(function* (spawn: SpawnOptions) {
          yield* Effect.annotateCurrentSpan(processAttributes(spawn))

          const handle = yield* launch(spawn)
          const pid = Pid.make(Number(handle.pid))
          const run = yield* recordRun(spawn, pid)
          const span = yield* lifetimeSpan(spawn, run)
          const logged = yield* Deferred.make<void>()

          yield* forwardOutput(spawn, handle, run, span, logged)
          yield* countStart(spawn)

          return mint({
            pid,
            run: runRef(run),
            exited: exitOf(spawn, handle, run, span),
            output: recentOutput(run),
            logged: Deferred.await(logged)
          })
        })

        const failedExec = (spawn: SpawnOptions, code: number, output: string) =>
          new SpawnError({ service: spawn.service, message: `${commandLine(spawn.run)} exited ${code}: ${lastLines(output)}` })

        const processTable = spawner.string(ChildProcess.make("ps", ["-A", "-o", "pid=,ppid=,%cpu=,rss="])).pipe(
          Effect.orElseSucceed(() => ""),
          Effect.withSpan("Proc.processTable"),
          Effect.withTracerEnabled(false)
        )

        const exec = Effect.fn("Proc.exec")(function* (spawn: SpawnOptions) {
          yield* Effect.annotateCurrentSpan(processAttributes(spawn))

          const handle = yield* launch(spawn)
          yield* registry.track({ pid: Pid.make(Number(handle.pid)), owner: spawn.owner, service: spawn.service })

          const [stdout, stderr, code] = yield* Effect.all([collect(handle.stdout), collect(handle.stderr), exitCodeOf(handle)], {
            concurrency: "unbounded"
          })
          yield* Effect.annotateCurrentSpan({ "process.exit_code": code })

          if (code !== 0) return yield* failedExec(spawn, code, stderr || stdout)
          return stdout
        })

        return Proc.of({ spawn, exec, processTable })
      })
    ).pipe(
      Layer.provide(NodeChildProcessSpawner.layer),
      Layer.provide(OtlpExporter.layerFlusher),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer)
    )
}
