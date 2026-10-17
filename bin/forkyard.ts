import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ForkyardClient } from "../src/Client.ts"
import { AbsolutePath, InfraName, ownerOfWorktree, ServiceName, type WorktreeId } from "../src/Ids.ts"
import { defaultHome, runDaemon } from "../src/main-daemon.ts"
import { attach as attachTui } from "../tui/Attach.ts"
import { type EnvVar, isSettled, runOf, serviceUrl, type Snapshot, stateDetail, stateLabel, type WorktreeView } from "../src/Model.ts"

const home = process.env.FORKYARD_HOME ?? defaultHome

const client = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const socket = path.join(home, "forkyard.sock")

    if (!(yield* fs.exists(socket))) return yield* Effect.fail("forkyard is not running. Start it with: forkyard daemon")
    return ForkyardClient.layer(socket)
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

const gitBranch = Effect.fn("gitBranch")(function* (root: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const path = yield* Path.Path
  const branch = yield* spawner.string(ChildProcess.make("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })).pipe(
    Effect.map((out) => out.trim()),
    Effect.orElseSucceed(() => "")
  )

  return branch && branch !== "HEAD" ? branch : path.basename(root)
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
  const name = Option.isSome(branch) ? branch.value : yield* gitBranch(root)

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

const up = Command.make("up", { branch: branchFlag }, ({ branch }) =>
  Effect.gen(function* () {
    const forkyard = yield* ForkyardClient
    const request = yield* target(branch)
    const { id } = yield* forkyard.Up(request)
    yield* Console.log(`${id} starting from ${request.root}`)

    const settled = yield* awaitSettled(id)
    yield* Option.match(settled, {
      onNone: () => Console.log("still starting, see forkyard status"),
      onSome: (worktree) => Console.log(describe(worktree!))
    })
    yield* Console.log(`dashboard: http://forkyard.localhost/#/wt/${id}`)
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

const attach = Command.make("attach", {}, () =>
  Effect.gen(function* () {
    const root = yield* findRoot(process.cwd()).pipe(Effect.option)
    const worktrees = Object.values(yield* snapshot)
    const here = worktrees.find((worktree) => Option.isSome(root) && worktree.root === root.value)

    yield* attachTui(yield* Effect.context<ForkyardClient>(), here?.id)
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Open the terminal UI: every worktree, then each one's services, logs, env and restarts"))

const forkyard = Command.make("forkyard").pipe(Command.withSubcommands([daemon, up, down, status, env, logs, attach, infraCommand]))

forkyard.pipe(Command.run({ version: "0.1.0" }), Effect.provide(NodeServices.layer), NodeRuntime.runMain)
