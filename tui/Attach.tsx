import { Box, render, Text, useApp, useStdout } from "ink"
import { type Context, Effect, Fiber } from "effect"
import { type ReactElement, useEffect, useReducer, useState } from "react"
import { spawn } from "node:child_process"
import { ForkyardClient } from "../src/Client.ts"
import { openUrlCommand } from "../src/platform/Os.ts"
import { type AbsolutePath, ServiceName, type WorktreeId } from "../src/Ids.ts"
import type { EnvVar, Snapshot, UsageMap } from "../src/Model.ts"
import { daemonFeed, emptyLogs, type Line, logsReducer, reconnecting, statusFeed, usageFeed, worktreeLogFeed } from "./Feeds.ts"
import { Home } from "./Home.tsx"
import { useMouseMode } from "./Mouse.ts"
import type { View } from "./View.ts"
import { NotRunning } from "./NotRunning.tsx"
import { theme } from "./Theme.ts"
import { Worktree } from "./Worktree.tsx"

const keepDaemon = 2000

const openUrl = (url: string) => {
  const command = openUrlCommand(url)
  spawn(command.command, [...command.args], { stdio: "ignore", detached: true }).unref()
}

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

const shownWorktree = (view: View, snapshot: Snapshot): WorktreeId | undefined => {
  if (view._tag === "Worktree") return view.id
  if (view._tag === "Home") return undefined
  return Object.values(snapshot).find((worktree) => worktree.root === view.root)?.id
}

const App = ({ context, initial }: AppProps) => {
  const { exit } = useApp()
  const fullRows = useRows()
  const [view, setView] = useState<View>(initial)
  const [received, setSnapshot] = useState<Snapshot | undefined>(undefined)
  const snapshot = received ?? {}
  const [daemon, setDaemon] = useState<ReadonlyArray<Line>>([])
  const [usage, setUsage] = useState<UsageMap>({})
  const [connected, setConnected] = useState(true)
  const rows = connected ? fullRows : fullRows - 1
  const [logs, dispatch] = useReducer(logsReducer, emptyLogs)

  const run = <A, E>(effect: Effect.Effect<A, E, ForkyardClient>) => Effect.runForkWith(context)(effect)
  const call = <A, E>(effect: Effect.Effect<A, E, ForkyardClient>) => Effect.runPromiseWith(context)(effect)

  useMouseMode()

  useEffect(() => {
    const ignore = () => undefined
    const receive = (next: Snapshot) => {
      setConnected(true)
      setSnapshot(next)
    }
    const status = run(reconnecting(statusFeed(receive), { start: ignore, lost: () => setConnected(false) }))
    const usageLines = run(reconnecting(usageFeed(setUsage), { start: ignore, lost: ignore }))
    const daemonLines = run(
      reconnecting(
        daemonFeed((_key, lines) => setDaemon((current) => [...current, ...lines].slice(-keepDaemon))),
        { start: () => setDaemon([]), lost: ignore }
      )
    )
    return () => {
      run(Fiber.interrupt(status))
      run(Fiber.interrupt(usageLines))
      run(Fiber.interrupt(daemonLines))
    }
  }, [])

  const worktreeId = shownWorktree(view, snapshot)

  useEffect(() => {
    dispatch({ _tag: "Reset" })
    if (!worktreeId) return
    const fiber = run(
      reconnecting(
        worktreeLogFeed(worktreeId, (key, lines) => dispatch({ _tag: "Lines", key, lines })),
        { start: () => dispatch({ _tag: "Reset" }), lost: () => undefined }
      )
    )
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

  const start = (root: AbsolutePath, branch: string) =>
    call(ForkyardClient.use((forkyard) => forkyard.Up({ root, branch })).pipe(Effect.asVoid))

  const framed = (content: ReactElement) =>
    connected ? (
      content
    ) : (
      <Box flexDirection="column" height={fullRows}>
        <Text color={theme.failed} wrap="truncate">
          {" ● lost the forkyard daemon, reconnecting… (it may be restarting)"}
        </Text>
        {content}
      </Box>
    )

  if (!received)
    return framed(
      <Text color={theme.muted} wrap="truncate">
        {" connecting to forkyard…"}
      </Text>
    )

  if (view._tag === "Checkout" && !worktree)
    return framed(
      <NotRunning
        root={view.root}
        branch={view.branch}
        rows={rows}
        onStart={() => start(view.root, view.branch)}
        onBack={() => setView({ _tag: "Home" })}
        onQuit={exit}
      />
    )

  if (worktreeId && worktree)
    return framed(
      <Worktree
        key={worktreeId}
        worktree={worktree}
        usage={usage}
        logs={logs}
        daemon={daemon}
        rows={rows}
        position={`${worktree.project} branch ${ids.indexOf(worktreeId) + 1} of ${ids.length}`}
        onBack={() => setView({ _tag: "Home" })}
        onSwitch={switchBy}
        onRestart={restart(worktreeId)}
        onEnv={envOf(worktreeId)}
        onOpenUrl={openUrl}
        onQuit={exit}
      />
    )

  return framed(
    <Home
      snapshot={snapshot}
      usage={usage}
      daemon={daemon}
      rows={rows}
      onOpen={(id: WorktreeId) => setView({ _tag: "Worktree", id })}
      onStop={stop}
      onDashboard={() => run(ForkyardClient.use((forkyard) => forkyard.Info()).pipe(Effect.map((info) => openUrl(info.dashboard))))}
      onQuit={exit}
    />
  )
}

export const attach = (context: Context.Context<ForkyardClient>, initial: View) =>
  Effect.promise(() => render(<App context={context} initial={initial} />, { exitOnCtrlC: false }).waitUntilExit())
