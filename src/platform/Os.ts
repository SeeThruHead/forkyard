import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { Command, Run } from "../Stack.ts"

export type ProcessRow = { readonly pid: number; readonly ppid: number; readonly cpu: number; readonly rssKb: number }

export type OsName = "darwin" | "linux" | "windows"

export type ProxyNetworking = { readonly args: ReadonlyArray<string>; readonly listenPort: (port: number) => number }

export class Os extends Context.Service<
  Os,
  {
    readonly name: OsName
    readonly commandFor: (run: Run) => Command
    readonly spawnGroup: { readonly detached: boolean; readonly killSignal: "SIGTERM" | undefined }
    readonly isAlive: (pid: number) => Effect.Effect<boolean>
    readonly killTree: (pid: number) => Effect.Effect<void>
    readonly processTable: Effect.Effect<ReadonlyArray<ProcessRow>>
    readonly ipcPath: (home: string) => string
    readonly ipcIsFile: boolean
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

const isAlive = (pid: number) =>
  signal(pid, 0).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )

const readTable = (command: string, args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.string(ChildProcess.make(command, [...args]))).pipe(
    Effect.map(parseTable),
    Effect.orElseSucceed((): ReadonlyArray<ProcessRow> => [])
  )

const replaceSelf = Effect.sync(() =>
  process.execve?.(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.env)
)

const unix = (name: "darwin" | "linux", spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): Os["Service"] => ({
  name,
  commandFor: (run) => (isShell(run) ? { command: "/bin/sh", args: ["-c", run.shell] } : run),
  spawnGroup: { detached: true, killSignal: "SIGTERM" },
  isAlive,
  killTree: (pid) => signal(-pid, "SIGKILL").pipe(Effect.ignore),
  processTable: readTable("ps", ["-A", "-o", "pid=,ppid=,%cpu=,rss="]).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
  ),
  ipcPath: (home) => join(home, "forkyard.sock"),
  ipcIsFile: true,
  hostsFile: "/etc/hosts",
  dockerProxy:
    name === "linux"
      ? () => ({ args: ["--network", "host"], listenPort: (port) => port })
      : (port) => ({ args: ["-p", `${port}:80`], listenPort: () => 80 }),
  dockerUpstream: name === "linux" ? "127.0.0.1" : "host.docker.internal",
  restartInPlace: replaceSelf
})

const windowsTable = [
  "-NoProfile",
  "-Command",
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) 0 $([math]::Round($_.WorkingSetSize / 1024))" }'
]

const windows = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): Os["Service"] => {
  const run = (command: string, args: ReadonlyArray<string>) =>
    spawner.exitCode(ChildProcess.make(command, [...args], { stdout: "ignore", stderr: "ignore" })).pipe(Effect.ignore)
  return {
    name: "windows",
    commandFor: (step) => (isShell(step) ? { command: "cmd.exe", args: ["/d", "/s", "/c", step.shell] } : step),
    spawnGroup: { detached: false, killSignal: undefined },
    isAlive,
    killTree: (pid) => run("taskkill", ["/PID", String(pid), "/T", "/F"]),
    processTable: readTable("powershell.exe", windowsTable).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    ipcPath: (home) => `\\\\.\\pipe\\forkyard-${createHash("sha256").update(home).digest("hex").slice(0, 12)}`,
    ipcIsFile: false,
    hostsFile: "C:\\Windows\\System32\\drivers\\etc\\hosts",
    dockerProxy: (port) => ({ args: ["-p", `${port}:80`], listenPort: () => 80 }),
    dockerUpstream: "host.docker.internal",
    restartInPlace: run(process.execPath, [...process.execArgv, ...process.argv.slice(1)])
  }
}

export const osName = (platform: NodeJS.Platform = process.platform): OsName => {
  if (platform === "darwin") return "darwin"
  if (platform === "win32") return "windows"
  return "linux"
}

export const openUrlCommand = (url: string, name: OsName = osName()): Command => {
  if (name === "darwin") return { command: "open", args: [url] }
  if (name === "windows") return { command: "cmd.exe", args: ["/d", "/c", "start", "", url] }
  return { command: "xdg-open", args: [url] }
}

export const layerFor = (name: OsName) =>
  Layer.effect(
    Os,
    ChildProcessSpawner.ChildProcessSpawner.use((spawner) => Effect.succeed(name === "windows" ? windows(spawner) : unix(name, spawner)))
  ).pipe(Layer.provide(NodeChildProcessSpawner.layer), Layer.provide(NodeFileSystem.layer), Layer.provide(NodePath.layer))

export const layer = layerFor(osName())
