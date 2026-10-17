import { Console, Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { homedir } from "node:os"
import { fromPackage, isSourceCheckout, packageRoot } from "../src/Package.ts"

const label = "dev.forkyard.daemon"
const trayCask = "forkyard-bar"

type Platform = "launchd" | "systemd"

const platform = (): Platform => (process.platform === "darwin" ? "launchd" : "systemd")

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

export const isInstalled = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.exists(platform() === "launchd" ? plistPath() : unitPath()).pipe(Effect.orElseSucceed(() => false))
})

export const install = Effect.fn("service.install")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const logFile = path.join(home, "daemon.log")
  yield* fs.makeDirectory(home, { recursive: true })

  if (platform() === "launchd") {
    yield* fs.makeDirectory(path.dirname(plistPath()), { recursive: true })
    yield* fs.writeFileString(plistPath(), plist(logFile))
    yield* quietly("launchctl", "bootout", `${launchdTarget()}/${label}`)
    yield* run("launchctl", "bootstrap", launchdTarget(), plistPath()).pipe(Effect.flatMap(mustSucceed("launchctl bootstrap")))
    return yield* Console.log(`forkyard daemon installed as a launchd agent (${plistPath()}); it starts at login and logs to ${logFile}`)
  }

  yield* fs.makeDirectory(path.dirname(unitPath()), { recursive: true })
  yield* fs.writeFileString(unitPath(), unit())
  yield* run("systemctl", "--user", "daemon-reload").pipe(Effect.flatMap(mustSucceed("systemctl daemon-reload")))
  yield* run("systemctl", "--user", "enable", "--now", "forkyard").pipe(
    Effect.flatMap(mustSucceed("systemctl enable (on WSL, set systemd=true under [boot] in /etc/wsl.conf)"))
  )
  yield* Console.log(
    `forkyard daemon installed as a systemd user service (${unitPath()}); run loginctl enable-linger to keep it running after logout`
  )
})

export const uninstall = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  if (platform() === "launchd") {
    yield* quietly("launchctl", "bootout", `${launchdTarget()}/${label}`)
    yield* fs.remove(plistPath(), { force: true })
    return yield* Console.log("forkyard daemon service removed")
  }
  yield* quietly("systemctl", "--user", "disable", "--now", "forkyard")
  yield* fs.remove(unitPath(), { force: true })
  yield* quietly("systemctl", "--user", "daemon-reload")
  yield* Console.log("forkyard daemon service removed")
})

export const restart = Effect.gen(function* () {
  if (!(yield* isInstalled)) return yield* Effect.fail("the daemon is not installed as a service; restart it where you started it")
  if (platform() === "launchd")
    return yield* run("launchctl", "kickstart", "-k", `${launchdTarget()}/${label}`).pipe(
      Effect.flatMap(mustSucceed("launchctl kickstart"))
    )
  return yield* run("systemctl", "--user", "restart", "forkyard").pipe(Effect.flatMap(mustSucceed("systemctl restart")))
})

export const status = Effect.gen(function* () {
  if (!(yield* isInstalled)) return yield* Console.log("not installed as a service")
  if (platform() === "launchd") return yield* run("launchctl", "print", `${launchdTarget()}/${label}`).pipe(Effect.asVoid)
  return yield* run("systemctl", "--user", "status", "--no-pager", "forkyard").pipe(Effect.asVoid)
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
