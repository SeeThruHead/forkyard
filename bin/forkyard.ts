#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ForkyardClient } from "../src/Client.ts"
import { AbsolutePath, InfraName, ownerOfWorktree, ServiceName, type WorktreeId } from "../src/Ids.ts"
import { defaultHome, runDaemon } from "../src/main-daemon.ts"
import { packageVersion, protocolVersion } from "../src/Package.ts"
import { attach as attachTui, type View } from "../tui/Attach.ts"
import * as Service from "./service.ts"
import { type EnvVar, isSettled, runOf, serviceUrl, type Snapshot, stateDetail, stateLabel, type WorktreeView } from "../src/Model.ts"

const home = process.env.FORKYARD_HOME ?? defaultHome

const tooOld = (daemon: string) =>
  `the running forkyard daemon is ${daemon}, older than this forkyard (v${packageVersion}, protocol ${protocolVersion}). Restart the daemon to upgrade it.`

const requireCompatibleDaemon = ForkyardClient.use((forkyard) => forkyard.Info()).pipe(
  Effect.mapError(() => tooOld("too old to report its version")),
  Effect.flatMap((info) =>
    (info.protocol ?? 0) < protocolVersion ? Effect.fail(tooOld(`v${info.version ?? "?"} (protocol ${info.protocol ?? 0})`)) : Effect.void
  )
)

const client = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const socket = path.join(home, "forkyard.sock")

    if (!(yield* fs.exists(socket))) return yield* Effect.fail("forkyard is not running. Start it with: forkyard daemon")
    return Layer.provideMerge(Layer.effectDiscard(requireCompatibleDaemon), ForkyardClient.layer(socket))
  })
)

const findRoot = Effect.fn("findRoot")(function* (dir: string): Effect.fn.Return<AbsolutePath, string, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = path.dirname(dir)

  if (yield* fs.exists(path.join(dir, "forkyard.config.ts")).pipe(Effect.orElseSucceed(() => false))) return AbsolutePath.make(dir)
  if (parent === dir) return yield* Effect.fail("no forkyard.config.ts in this directory or any parent")
  return yield* findRoot(parent)
})

const firstLine = (output: string) => output.trim().split(/[\n,]/)[0]?.trim() ?? ""

const askVcs = (root: string, command: string, args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.string(ChildProcess.make(command, [...args], { cwd: root }))).pipe(
    Effect.map(firstLine),
    Effect.orElseSucceed(() => "")
  )

const jjBookmark = (root: string) =>
  askVcs(root, "jj", ["log", "-r", "heads(::@ & bookmarks())", "--no-graph", "-T", 'local_bookmarks.map(|b| b.name()).join(",") ++ "\\n"'])

const gitBranch = (root: string) =>
  askVcs(root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(Effect.map((branch) => (branch === "HEAD" ? "" : branch)))

const branchOf = Effect.fn("branchOf")(function* (root: string) {
  const path = yield* Path.Path
  const jj = yield* jjBookmark(root)
  if (jj) return jj
  const git = yield* gitBranch(root)
  if (git) return git
  return path.basename(root)
})

const describe = (worktree: WorktreeView) => {
  const infra = Object.entries(worktree.infra).map(
    ([name, view]) =>
      `  ${name.padEnd(14)} ${view._tag.replace("Infra", "").toLowerCase().padEnd(10)} ${"url" in view ? (view.url ?? "") : ""}`
  )
  const services = Object.entries(worktree.services).map(
    ([name, view]) => `  ${name.padEnd(14)} ${stateLabel(view.state).padEnd(10)} ${serviceUrl(view) ?? stateDetail(view.state) ?? ""}`
  )

  return [...infra, ...services].join("\n")
}

const target = Effect.fn("target")(function* (branch: Option.Option<string>) {
  const root = yield* findRoot(process.cwd())
  const name = Option.isSome(branch) ? branch.value : yield* branchOf(root)

  return { root, branch: name }
})

const snapshot = ForkyardClient.use((forkyard) =>
  forkyard.Status().pipe(Stream.runHead, Effect.map(Option.getOrElse((): Snapshot => ({}))))
)

const runningHere = Effect.fn("runningHere")(function* () {
  const root = yield* findRoot(process.cwd())
  const match = Object.values(yield* snapshot).find((worktree) => worktree.root === root)

  if (!match) return yield* Effect.fail("this worktree is not running. Start it with: forkyard up")
  return match
})

const serviceArgument = Argument.String("service").pipe(Argument.withDescription("Service name from forkyard.config.ts"))

const parseService = (name: string) => ServiceName.makeEffect(name).pipe(Effect.mapError(() => `"${name}" is not a service name`))

const branchFlag = Flag.String("branch").pipe(Flag.optional, Flag.withDescription("Branch name to use instead of the git branch"))

const daemon = Command.make("daemon", {}, () => runDaemon(home)).pipe(Command.withDescription("Run the forkyard daemon in the foreground"))

const awaitSettled = (id: WorktreeId) =>
  ForkyardClient.use((forkyard) =>
    forkyard.Status().pipe(
      Stream.map((all) => all[id]),
      Stream.filter(isSettled),
      Stream.runHead,
      Effect.timeout("180 seconds")
    )
  )

const profileFlag = Flag.String("profile").pipe(Flag.withDefault("default"), Flag.withDescription("Profile from forkyard.config.ts"))

const up = Command.make("up", { branch: branchFlag, profile: profileFlag }, ({ branch, profile }) =>
  Effect.gen(function* () {
    const forkyard = yield* ForkyardClient
    const request = yield* target(branch)
    const { id } = yield* forkyard.Up({ ...request, profile })
    yield* Console.log(`${id} starting from ${request.root}`)

    const settled = yield* awaitSettled(id)
    yield* Option.match(settled, {
      onNone: () => Console.log("still starting, see forkyard status"),
      onSome: (worktree) => Console.log(describe(worktree!))
    })
    yield* Console.log(`dashboard: ${(yield* forkyard.Info()).dashboard}/#/wt/${id}`)
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Start this worktree's stack"))

const down = Command.make("down", {}, () =>
  Effect.gen(function* () {
    const forkyard = yield* ForkyardClient
    const worktree = yield* runningHere()

    yield* forkyard.Down({ id: worktree.id })
    yield* Console.log(`${worktree.id} stopped`)
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Stop this worktree's stack"))

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const worktrees = Object.values(yield* snapshot)
    const lines = worktrees.map((worktree) => `${worktree.id}  (${worktree.root})\n${describe(worktree)}`)

    yield* Console.log(lines.length === 0 ? "no worktrees running" : lines.join("\n\n"))
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Show every running worktree"))

const formatEnvLine = (entry: EnvVar) =>
  `${entry.key.padEnd(38)} ${entry.source.padEnd(18)} ${entry.value}${entry.replaced ? `   (was ${entry.replaced})` : ""}${entry.warning ? "   !" : ""}`

const env = Command.make("env", { service: serviceArgument }, ({ service }) =>
  Effect.gen(function* () {
    const forkyard = yield* ForkyardClient
    const worktree = yield* runningHere()
    const name = yield* parseService(service)
    const vars = yield* forkyard.Env({ id: worktree.id, service: name })

    yield* Console.log(vars.map(formatEnvLine).join("\n"))
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Show the env a service was started with, and where each value came from"))

const logs = Command.make("logs", { service: serviceArgument }, ({ service }) =>
  Effect.gen(function* () {
    const forkyard = yield* ForkyardClient
    const worktree = yield* runningHere()
    const name = yield* parseService(service)
    const run = runOf(worktree.services[name]?.state ?? { _tag: "Waiting" })

    if (!run) return yield* Console.log(`${service} has not started yet`)

    yield* Console.log(`run #${run.run} (pid ${run.pid}) of ${ownerOfWorktree(worktree.id)}/${service}`)
    yield* forkyard.RunLog({ runId: run.runId }).pipe(Stream.runForEach((line) => Console.log(line.line)))
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Follow the current run's logs for a service"))

const infraArgument = Argument.String("infra").pipe(Argument.withDescription("Infra name from forkyard.config.ts, e.g. postgres"))
const actionArgument = Argument.String("action").pipe(Argument.withDescription("What to do, e.g. refresh-golden or reset-database"))

const infraCommand = Command.make("infra", { infra: infraArgument, action: actionArgument }, ({ infra, action }) =>
  Effect.gen(function* () {
    const forkyard = yield* ForkyardClient
    const worktree = yield* runningHere()
    const result = yield* forkyard.InfraAction({ id: worktree.id, infra: InfraName.make(infra), action })

    yield* Console.log(result)
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Run an action on this worktree's infra, e.g. forkyard infra postgres refresh-golden"))

const startTarget = Effect.fn("startTarget")(function* () {
  const root = yield* findRoot(process.cwd()).pipe(Effect.option)
  if (Option.isNone(root)) return undefined
  return { root: root.value, branch: yield* branchOf(root.value) }
})

const startingView = (id: WorktreeId | undefined, checkout: { readonly root: AbsolutePath; readonly branch: string } | undefined): View => {
  if (id) return { _tag: "Worktree", id }
  if (checkout) return { _tag: "Checkout", ...checkout }
  return { _tag: "Home" }
}

const attach = Command.make("attach", {}, () =>
  Effect.gen(function* () {
    const checkout = yield* startTarget()
    const worktrees = Object.values(yield* snapshot)
    const here = worktrees.find((worktree) => worktree.root === checkout?.root)

    yield* attachTui(yield* Effect.context<ForkyardClient>(), startingView(here?.id, checkout))
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Open the terminal UI on this checkout's worktree, or on every worktree when run elsewhere"))

const serviceInstall = Command.make("install", {}, () => Service.install(home)).pipe(
  Command.withDescription("Run the daemon as a login service (launchd on macOS, systemd on Linux and WSL)")
)
const serviceUninstall = Command.make("uninstall", {}, () => Service.uninstall).pipe(Command.withDescription("Remove the daemon service"))
const serviceRestart = Command.make("restart", {}, () => Service.restart).pipe(Command.withDescription("Restart the daemon service"))
const serviceStatus = Command.make("status", {}, () => Service.status).pipe(Command.withDescription("Show the daemon service's state"))
const service = Command.make("service").pipe(
  Command.withSubcommands([serviceInstall, serviceUninstall, serviceRestart, serviceStatus]),
  Command.withDescription("Manage the daemon as a background service")
)

const update = Command.make("update", {}, () => Service.update).pipe(
  Command.withDescription("Update forkyard, the menu bar app if installed with brew, and the running daemon")
)

const forkyard = Command.make("forkyard").pipe(
  Command.withSubcommands([daemon, up, down, status, env, logs, attach, infraCommand, service, update])
)

forkyard.pipe(Command.run({ version: "0.1.0" }), Effect.provide(NodeServices.layer), NodeRuntime.runMain)
