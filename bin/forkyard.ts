import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ForkyardClient } from "../src/Client.ts"
import { defaultHome, runDaemon } from "../src/main-daemon.ts"
import type { WorktreeStatus } from "../src/Model.ts"

const home = process.env.FORKYARD_HOME ?? defaultHome

const client = Layer.unwrap(
  Effect.gen(function*() {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const socket = path.join(home, "forkyard.sock")
    if (!(yield* fs.exists(socket))) return yield* Effect.fail(`forkyard is not running. Start it with: forkyard daemon`)
    return ForkyardClient.layer(socket)
  })
)

const findRoot = Effect.fn("findRoot")(function*(dir: string): Effect.fn.Return<string, string, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (yield* fs.exists(path.join(dir, "forkyard.config.ts")).pipe(Effect.orElseSucceed(() => false))) return dir
  const parent = path.dirname(dir)
  if (parent === dir) return yield* Effect.fail("no forkyard.config.ts in this directory or any parent")
  return yield* findRoot(parent)
})

const gitBranch = (root: string) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const path = yield* Path.Path
    const branch = yield* spawner
      .string(ChildProcess.make("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }))
      .pipe(Effect.map((out) => out.trim()), Effect.orElseSucceed(() => ""))
    return branch && branch !== "HEAD" ? branch : path.basename(root)
  })

const settled = (worktree: WorktreeStatus | undefined) => {
  if (!worktree) return false
  const services = Object.values(worktree.services)
  if (services.length === 0) return false
  return services.every((service) => ["ready", "done", "failed"].includes(service.state))
}

const describe = (worktree: WorktreeStatus) =>
  Object.entries(worktree.services)
    .map(([name, service]) => `  ${name.padEnd(14)} ${service.state.padEnd(9)} ${service.url ?? service.detail ?? ""}`)
    .join("\n")

const worktreeId = (branch: Option.Option<string>) =>
  Effect.gen(function*() {
    const root = yield* findRoot(process.cwd())
    const name = Option.isSome(branch) ? branch.value : yield* gitBranch(root)
    return { root, branch: name }
  })

const branchFlag = Flag.String("branch").pipe(Flag.optional, Flag.withDescription("Branch name to use instead of the git branch"))

const daemon = Command.make("daemon", {}, () => runDaemon(home)).pipe(Command.withDescription("Run the forkyard daemon in the foreground"))

const up = Command.make("up", { branch: branchFlag }, ({ branch }) =>
  Effect.gen(function*() {
    const target = yield* worktreeId(branch)
    const forkyard = yield* ForkyardClient
    const { id } = yield* forkyard.Up(target)
    yield* Console.log(`${id} starting from ${target.root}`)
    const ready = yield* forkyard.Status().pipe(
      Stream.map((snapshot) => snapshot[id]),
      Stream.filter(settled),
      Stream.runHead,
      Effect.timeout("180 seconds")
    )
    yield* Option.match(ready, { onNone: () => Console.log("still starting, see forkyard status"), onSome: (worktree) => Console.log(describe(worktree!)) })
    yield* Console.log(`dashboard: http://forkyard.localhost/#/wt/${id}`)
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Start this worktree's stack"))

const down = Command.make("down", { branch: branchFlag }, ({ branch }) =>
  Effect.gen(function*() {
    const forkyard = yield* ForkyardClient
    const snapshot = yield* forkyard.Status().pipe(Stream.runHead, Effect.map(Option.getOrElse(() => ({}))))
    const target = yield* worktreeId(branch)
    const match = Object.values(snapshot).find((worktree) => worktree.root === target.root)
    if (!match) return yield* Console.log(`nothing running for ${target.root}`)
    yield* forkyard.Down({ id: match.id })
    yield* Console.log(`${match.id} stopped`)
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Stop this worktree's stack"))

const status = Command.make("status", {}, () =>
  Effect.gen(function*() {
    const forkyard = yield* ForkyardClient
    const snapshot = yield* forkyard.Status().pipe(Stream.runHead, Effect.map(Option.getOrElse(() => ({}))))
    const lines = Object.values(snapshot).map((worktree) => `${worktree.id}  (${worktree.root})\n${describe(worktree)}`)
    yield* Console.log(lines.length === 0 ? "no worktrees running" : lines.join("\n\n"))
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Show every running worktree"))

const currentId = Effect.gen(function*() {
  const forkyard = yield* ForkyardClient
  const root = yield* findRoot(process.cwd())
  const snapshot = yield* forkyard.Status().pipe(Stream.runHead, Effect.map(Option.getOrElse(() => ({}))))
  const match = Object.values(snapshot).find((worktree) => worktree.root === root)
  return match ? match.id : yield* Effect.fail(`this worktree is not running. Start it with: forkyard up`)
})

const env = Command.make("env", { service: Argument.String("service") }, ({ service }) =>
  Effect.gen(function*() {
    const forkyard = yield* ForkyardClient
    const vars = yield* forkyard.Env({ id: yield* currentId, service })
    yield* Console.log(
      vars.map((entry) => `${entry.key.padEnd(38)} ${entry.source.padEnd(18)} ${entry.value}${entry.replaced ? `   (was ${entry.replaced})` : ""}${entry.warning ? "   !" : ""}`).join("\n")
    )
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Show the env a service was started with, and where each value came from"))

const logs = Command.make("logs", { service: Argument.String("service") }, ({ service }) =>
  Effect.gen(function*() {
    const forkyard = yield* ForkyardClient
    const runs = yield* forkyard.Runs({ id: yield* currentId, service })
    const latest = runs[0]
    if (!latest) return yield* Console.log(`no runs of ${service} yet`)
    yield* Console.log(`run #${latest.n} (pid ${latest.pid})`)
    yield* forkyard.RunLog({ runId: latest.id }).pipe(Stream.runForEach((line) => Console.log(line.line)))
  }).pipe(Effect.scoped, Effect.provide(client))
).pipe(Command.withDescription("Follow the latest run's logs for a service"))

const forkyard = Command.make("forkyard").pipe(Command.withSubcommands([daemon, up, down, status, env, logs]))

forkyard.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
