import { Console, Effect, FileSystem, Path, type PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { homedir } from "node:os"
import { fromPackage, isSourceCheckout, packageRoot } from "../src/Package.ts"
import { osName } from "../src/platform/Os.ts"

const label = "dev.forkyard.daemon"
const trayCask = "forkyard-bar"

const launchdTarget = () => `gui/${process.getuid?.() ?? 0}`

const plistPath = () => `${homedir()}/Library/LaunchAgents/${label}.plist`

const unitPath = () => `${homedir()}/.config/systemd/user/forkyard.service`

const daemonCommand = (): ReadonlyArray<string> =>
  isSourceCheckout
    ? [process.execPath, "--conditions=forkyard-source", "--no-warnings", fromPackage("bin", "forkyard.ts"), "daemon"]
    : [process.execPath, fromPackage("dist", "bin", "forkyard.js"), "daemon"]

const serviceEnv = (): Readonly<Record<string, string>> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: homedir(),
  ...Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].startsWith("FORKYARD_") && entry[1] !== undefined)
  ),
  FORKYARD_SUPERVISED: "true"
})

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const plist = (logFile: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${daemonCommand()
    .map((part) => `<string>${xml(part)}</string>`)
    .join("")}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(serviceEnv())
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`

const unit = () => `[Unit]
Description=forkyard daemon

[Service]
ExecStart=${daemonCommand()
  .map((part) => (part.includes(" ") ? `"${part}"` : part))
  .join(" ")}
${Object.entries(serviceEnv())
  .map(([key, value]) => `Environment="${key}=${value}"`)
  .join("\n")}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`

const run = (command: string, ...args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.exitCode(ChildProcess.make(command, [...args], { stdout: "inherit", stderr: "inherit" }))
  ).pipe(
    Effect.map((code) => Number(code)),
    Effect.orElseSucceed(() => 127)
  )

const quietly = (command: string, ...args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.exitCode(ChildProcess.make(command, [...args], { stdout: "ignore", stderr: "ignore" }))
  ).pipe(
    Effect.map((code) => Number(code)),
    Effect.orElseSucceed(() => 127)
  )

const mustSucceed = (what: string) => (code: number) => (code === 0 ? Effect.void : Effect.fail(`${what} failed (exit ${code})`))

type ServiceManager = {
  readonly definition: string
  readonly install: (
    home: string,
    logFile: string
  ) => Effect.Effect<
    string,
    string | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >
  readonly uninstall: Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>
  readonly restart: Effect.Effect<void, string, ChildProcessSpawner.ChildProcessSpawner>
  readonly status: Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner>
}

const launchd: ServiceManager = {
  definition: plistPath(),
  install: Effect.fnUntraced(function* (_home, logFile) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(plistPath()), { recursive: true })
    yield* fs.writeFileString(plistPath(), plist(logFile))
    yield* quietly("launchctl", "bootout", `${launchdTarget()}/${label}`)
    yield* run("launchctl", "bootstrap", launchdTarget(), plistPath()).pipe(Effect.flatMap(mustSucceed("launchctl bootstrap")))
    return `a launchd agent (${plistPath()}); it starts at login`
  }),
  uninstall: Effect.gen(function* () {
    yield* quietly("launchctl", "bootout", `${launchdTarget()}/${label}`)
    yield* FileSystem.FileSystem.use((fs) => fs.remove(plistPath(), { force: true }))
  }),
  restart: run("launchctl", "kickstart", "-k", `${launchdTarget()}/${label}`).pipe(Effect.flatMap(mustSucceed("launchctl kickstart"))),
  status: run("launchctl", "print", `${launchdTarget()}/${label}`).pipe(Effect.asVoid)
}

const systemd: ServiceManager = {
  definition: unitPath(),
  install: Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(unitPath()), { recursive: true })
    yield* fs.writeFileString(unitPath(), unit())
    yield* run("systemctl", "--user", "daemon-reload").pipe(Effect.flatMap(mustSucceed("systemctl daemon-reload")))
    yield* run("systemctl", "--user", "enable", "--now", "forkyard").pipe(
      Effect.flatMap(mustSucceed("systemctl enable (on WSL, set systemd=true under [boot] in /etc/wsl.conf)"))
    )
    return `a systemd user service (${unitPath()}); run loginctl enable-linger to keep it running after logout`
  }),
  uninstall: Effect.gen(function* () {
    yield* quietly("systemctl", "--user", "disable", "--now", "forkyard")
    yield* FileSystem.FileSystem.use((fs) => fs.remove(unitPath(), { force: true }))
    yield* quietly("systemctl", "--user", "daemon-reload")
  }),
  restart: run("systemctl", "--user", "restart", "forkyard").pipe(Effect.flatMap(mustSucceed("systemctl restart"))),
  status: run("systemctl", "--user", "status", "--no-pager", "forkyard").pipe(Effect.asVoid)
}

const windowsScript = () => `${process.env.FORKYARD_HOME ?? `${homedir()}\\.forkyard`}\\forkyard-daemon.cmd`

const cmdScript = (logFile: string) =>
  [
    "@echo off",
    ...Object.entries(serviceEnv()).map(([key, value]) => `set "${key}=${value}"`),
    ":run",
    `${daemonCommand()
      .map((part) => `"${part}"`)
      .join(" ")} >> "${logFile}" 2>&1`,
    "timeout /t 2 /nobreak > nul",
    "goto run",
    ""
  ].join("\r\n")

const taskScheduler: ServiceManager = {
  definition: windowsScript(),
  install: Effect.fnUntraced(function* (_home, logFile) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(windowsScript(), cmdScript(logFile))
    yield* run("schtasks", "/Create", "/TN", "forkyard", "/TR", `"${windowsScript()}"`, "/SC", "ONLOGON", "/F").pipe(
      Effect.flatMap(mustSucceed("schtasks /Create"))
    )
    yield* run("schtasks", "/Run", "/TN", "forkyard").pipe(Effect.flatMap(mustSucceed("schtasks /Run")))
    return `a Task Scheduler task that starts at logon and restarts the daemon when it exits (${windowsScript()})`
  }),
  uninstall: Effect.gen(function* () {
    yield* quietly("schtasks", "/End", "/TN", "forkyard")
    yield* quietly("schtasks", "/Delete", "/TN", "forkyard", "/F")
    yield* FileSystem.FileSystem.use((fs) => fs.remove(windowsScript(), { force: true }))
  }),
  restart: quietly("schtasks", "/End", "/TN", "forkyard").pipe(
    Effect.andThen(run("schtasks", "/Run", "/TN", "forkyard")),
    Effect.flatMap(mustSucceed("schtasks /Run"))
  ),
  status: run("schtasks", "/Query", "/TN", "forkyard", "/V", "/FO", "LIST").pipe(Effect.asVoid)
}

const manager = (): ServiceManager => {
  if (osName() === "darwin") return launchd
  if (osName() === "windows") return taskScheduler
  return systemd
}

export const isInstalled = FileSystem.FileSystem.use((fs) => fs.exists(manager().definition)).pipe(Effect.orElseSucceed(() => false))

export const install = Effect.fn("service.install")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const logFile = path.join(home, "daemon.log")
  yield* fs.makeDirectory(home, { recursive: true })
  const installed = yield* manager().install(home, logFile)
  yield* Console.log(`forkyard daemon installed as ${installed}; it logs to ${logFile}`)
})

export const uninstall = manager().uninstall.pipe(Effect.andThen(Console.log("forkyard daemon service removed")))

export const restart = Effect.gen(function* () {
  if (!(yield* isInstalled)) return yield* Effect.fail("the daemon is not installed as a service; restart it where you started it")
  return yield* manager().restart
})

export const status = Effect.gen(function* () {
  if (!(yield* isInstalled)) return yield* Console.log("not installed as a service")
  return yield* manager().status
})

type InstallMethod = "source" | "brew" | "pnpm" | "npm"

const installMethod = (): InstallMethod => {
  if (isSourceCheckout) return "source"
  if (packageRoot.includes("/Cellar/")) return "brew"
  if (packageRoot.includes("/pnpm/")) return "pnpm"
  return "npm"
}

const upgradePackage = (method: InstallMethod) => {
  if (method === "brew") return run("brew", "upgrade", "forkyard")
  if (method === "pnpm") return run("pnpm", "add", "-g", "forkyard@latest")
  return run("npm", "install", "-g", "forkyard@latest")
}

const upgradeTray = Effect.gen(function* () {
  if ((yield* quietly("brew", "list", "--cask", trayCask)) !== 0) return
  yield* Console.log(`updating the ${trayCask} menu bar app`)
  yield* run("brew", "upgrade", "--cask", trayCask)
})

export const update = Effect.gen(function* () {
  const method = installMethod()
  if (method === "source")
    return yield* Console.log(`forkyard runs from a source checkout (${packageRoot}): git pull and pnpm install there instead`)

  yield* Console.log(`updating forkyard (installed with ${method})`)
  yield* upgradePackage(method).pipe(Effect.flatMap(mustSucceed(`${method} upgrade`)))
  yield* upgradeTray
  if (yield* isInstalled)
    return yield* Console.log(
      "the daemon service notices the new version within a few seconds and restarts onto it (migrations run on start)"
    )
  yield* Console.log("restart the daemon to switch to the new version")
})
