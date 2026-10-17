import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import type { Command, Run } from "../Stack.ts"

export type ProcessRow = { readonly pid: number; readonly ppid: number; readonly cpu: number; readonly rssKb: number }

export type OsName = "darwin" | "linux"

export type ProxyNetworking = { readonly args: ReadonlyArray<string>; readonly listenPort: (port: number) => number }

export class Os extends Context.Service<
  Os,
  {
    readonly name: OsName
    readonly commandFor: (run: Run) => Command
    readonly spawnGroup: { readonly detached: boolean; readonly killSignal: "SIGTERM" | undefined }
    readonly killTree: (pid: number) => Effect.Effect<void>
    readonly startedAt: (pid: number) => Effect.Effect<number | undefined>
    readonly processTable: Effect.Effect<ReadonlyArray<ProcessRow>>
    readonly ipcPath: (home: string) => string
    readonly hostsFile: string
    readonly dockerProxy: (port: number) => ProxyNetworking
    readonly dockerUpstream: string
    readonly restartInPlace: Effect.Effect<void>
  }
>()("forkyard/Os") {}

export const isShell = (run: Run): run is { readonly shell: string } => "shell" in run

export const parseTable = (output: string): ReadonlyArray<ProcessRow> =>
  output
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => parts.length === 4 && parts.every((part) => !Number.isNaN(part)))
    .map(([pid, ppid, cpu, rssKb]) => ({ pid: pid!, ppid: ppid!, cpu: cpu!, rssKb: rssKb! }))

const signal = (pid: number, name: NodeJS.Signals | 0) => Effect.try({ try: () => process.kill(pid, name), catch: () => false })

const readTable = (command: string, args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.string(ChildProcess.make(command, [...args]))).pipe(
    Effect.map(parseTable),
    Effect.orElseSucceed((): ReadonlyArray<ProcessRow> => [])
  )

export const runInstead = (launcher: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
  spawnSync(launcher, [...args], { stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1

const ownCommand = () => [...process.execArgv, ...process.argv.slice(1)]

const replaceSelf = Effect.sync(() => {
  if (process.execve) return process.execve(process.execPath, [process.execPath, ...ownCommand()], process.env)
  process.exit(spawnSync(process.execPath, ownCommand(), { stdio: "inherit" }).status ?? 1)
})

const startedAt = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => (pid: number) =>
  spawner.string(ChildProcess.make("ps", ["-o", "lstart=", "-p", String(pid)], { env: { LC_ALL: "C" }, extendEnv: true })).pipe(
    Effect.map((text) => Date.parse(text.trim())),
    Effect.map((millis) => (Number.isNaN(millis) ? undefined : millis)),
    Effect.orElseSucceed(() => undefined)
  )

const unix = (name: "darwin" | "linux", spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): Os["Service"] => ({
  name,
  commandFor: (run) => (isShell(run) ? { command: "/bin/sh", args: ["-c", run.shell] } : run),
  spawnGroup: { detached: true, killSignal: "SIGTERM" },
  killTree: (pid) => signal(-pid, "SIGKILL").pipe(Effect.ignore),
  startedAt: startedAt(spawner),
  processTable: readTable("ps", ["-A", "-o", "pid=,ppid=,%cpu=,rss="]).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
  ),
  ipcPath: (home) => join(home, "forkyard.sock"),
  hostsFile: "/etc/hosts",
  dockerProxy:
    name === "linux"
      ? () => ({ args: ["--network", "host"], listenPort: (port) => port })
      : (port) => ({ args: ["-p", `${port}:80`], listenPort: () => 80 }),
  dockerUpstream: name === "linux" ? "127.0.0.1" : "host.docker.internal",
  restartInPlace: replaceSelf
})

export const osName = (platform: NodeJS.Platform = process.platform): OsName => (platform === "darwin" ? "darwin" : "linux")

export const unsupportedHere = (platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? "forkyard runs on Windows through WSL: install it inside your WSL distribution and run it there." : undefined

export const openUrlCommand = (url: string, name: OsName = osName()): Command =>
  name === "darwin" ? { command: "open", args: [url] } : { command: "xdg-open", args: [url] }

export const layerFor = (name: OsName) =>
  Layer.effect(
    Os,
    ChildProcessSpawner.ChildProcessSpawner.use((spawner) => Effect.succeed(unix(name, spawner)))
  ).pipe(Layer.provide(NodeChildProcessSpawner.layer), Layer.provide(NodeFileSystem.layer), Layer.provide(NodePath.layer))

export const layer = layerFor(osName())
