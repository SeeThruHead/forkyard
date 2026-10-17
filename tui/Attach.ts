import { render, useApp, useStdout } from "ink"
import { type Context, Effect, Fiber } from "effect"
import { createElement as h, useEffect, useReducer, useState } from "react"
import { spawn } from "node:child_process"
import { ForkyardClient } from "../src/Client.ts"
import { ServiceName, type WorktreeId } from "../src/Ids.ts"
import type { EnvVar, Snapshot, UsageMap } from "../src/Model.ts"
import { daemonFeed, emptyLogs, type Line, logsReducer, statusFeed, usageFeed, worktreeLogFeed } from "./Feeds.ts"
import { Home } from "./Home.ts"
import { useMouseMode } from "./Mouse.ts"
import { Worktree } from "./Worktree.ts"

type View = { readonly _tag: "Home" } | { readonly _tag: "Worktree"; readonly id: WorktreeId }

const keepDaemon = 2000

const openUrl = (url: string) =>
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref()

const useRows = () => {
  const stdout = useStdout().stdout as NodeJS.WriteStream
  const [rows, setRows] = useState(stdout.rows ?? 40)
  useEffect(() => {
    const onResize = () => setRows(stdout.rows ?? 40)
    stdout.on("resize", onResize)
    return () => {
      stdout.off("resize", onResize)
    }
  }, [stdout])
  return rows
}

type AppProps = { readonly context: Context.Context<ForkyardClient>; readonly initial: View }

const App = ({ context, initial }: AppProps) => {
  const { exit } = useApp()
  const rows = useRows()
  const [view, setView] = useState<View>(initial)
  const [snapshot, setSnapshot] = useState<Snapshot>({})
  const [daemon, setDaemon] = useState<ReadonlyArray<Line>>([])
  const [usage, setUsage] = useState<UsageMap>({})
  const [logs, dispatch] = useReducer(logsReducer, emptyLogs)

  const run = <A, E>(effect: Effect.Effect<A, E, ForkyardClient>) => Effect.runForkWith(context)(effect)
  const call = <A, E>(effect: Effect.Effect<A, E, ForkyardClient>) => Effect.runPromiseWith(context)(effect)

  useMouseMode()

  useEffect(() => {
    const status = run(statusFeed(setSnapshot))
    const usageLines = run(usageFeed(setUsage))
    const daemonLines = run(daemonFeed((_key, lines) => setDaemon((current) => [...current, ...lines].slice(-keepDaemon))))
    return () => {
      run(Fiber.interrupt(status))
      run(Fiber.interrupt(usageLines))
      run(Fiber.interrupt(daemonLines))
    }
  }, [])

  const worktreeId = view._tag === "Worktree" ? view.id : undefined

  useEffect(() => {
    dispatch({ _tag: "Reset" })
    if (!worktreeId) return
    const fiber = run(worktreeLogFeed(worktreeId, (key, lines) => dispatch({ _tag: "Lines", key, lines })))
    return () => {
      run(Fiber.interrupt(fiber))
    }
  }, [worktreeId])

  const project = worktreeId ? snapshot[worktreeId]?.project : undefined
  const ids = Object.values(snapshot)
    .filter((other) => other.project === project)
    .map((other) => other.id)
    .sort()
  const switchBy = (step: number) => {
    if (!worktreeId) return
    const next = ids[(ids.indexOf(worktreeId) + step + ids.length) % ids.length]
    if (next) setView({ _tag: "Worktree", id: next })
  }
  const stop = (id: WorktreeId) => run(ForkyardClient.use((forkyard) => forkyard.Down({ id })))
  const restart = (id: WorktreeId) => (service: string) =>
    run(ForkyardClient.use((forkyard) => forkyard.Restart({ id, service: ServiceName.make(service) })))
  const envOf =
    (id: WorktreeId) =>
    (service: string): Promise<ReadonlyArray<EnvVar>> =>
      call(ForkyardClient.use((forkyard) => forkyard.Env({ id, service: ServiceName.make(service) })))

  const worktree = worktreeId ? snapshot[worktreeId] : undefined

  if (worktreeId && worktree)
    return h(Worktree, {
      key: worktreeId,
      worktree,
      usage,
      logs,
      daemon,
      rows,
      position: `${worktree.project} branch ${ids.indexOf(worktreeId) + 1} of ${ids.length}`,
      onBack: () => setView({ _tag: "Home" }),
      onSwitch: switchBy,
      onRestart: restart(worktreeId),
      onEnv: envOf(worktreeId),
      onOpenUrl: openUrl,
      onQuit: exit
    })

  return h(Home, {
    snapshot,
    usage,
    daemon,
    rows,
    onOpen: (id: WorktreeId) => setView({ _tag: "Worktree", id }),
    onStop: stop,
    onDashboard: () => openUrl("http://forkyard.localhost"),
    onQuit: exit
  })
}

export const attach = (context: Context.Context<ForkyardClient>, initial: WorktreeId | undefined) =>
  Effect.promise(() =>
    render(h(App, { context, initial: initial ? { _tag: "Worktree", id: initial } : { _tag: "Home" } }), {
      exitOnCtrlC: false
    }).waitUntilExit()
  )
