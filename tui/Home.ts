import { Box, Text, useInput } from "ink"
import { createElement as h, useState } from "react"
import type { WorktreeId } from "../src/Ids.ts"
import { runOf, serviceUrl, type Snapshot, type UsageMap, type WorktreeView } from "../src/Model.ts"
import type { Line } from "./Feeds.ts"
import { ButtonBar, clickedButton, isClick, isMouseInput, isWheel, isWheelDown, type Mouse, place, useMouse } from "./Mouse.ts"
import { formatCpu, formatMem, sumUsage, type Usage, usageFor } from "./Stats.ts"
import { stateColor, theme } from "./Theme.ts"

type Props = {
  readonly snapshot: Snapshot
  readonly usage: UsageMap
  readonly daemon: ReadonlyArray<Line>
  readonly rows: number
  readonly onOpen: (id: WorktreeId) => void
  readonly onStop: (id: WorktreeId) => void
  readonly onDashboard: () => void
  readonly onQuit: () => void
}

const bottomHeight = 12
const firstRow = 4

const branchOrder = (a: WorktreeView, b: WorktreeView) => {
  if (a.project !== b.project) return a.project.localeCompare(b.project)
  if (a.branch === "main") return -1
  if (b.branch === "main") return 1
  return a.branch.localeCompare(b.branch)
}

const pidsOf = (worktree: WorktreeView) =>
  Object.values(worktree.services).flatMap((view) => {
    const run = runOf(view.state)
    return run ? [run.pid] : []
  })

const counts = (worktree: WorktreeView) => {
  const states = Object.values(worktree.services).map((view) => view.state._tag)
  return {
    total: states.length,
    settled: states.filter((state) => state === "Ready" || state === "Done").length,
    failed: states.filter((state) => state === "Failed").length,
    busy: states.filter((state) => ["Waiting", "Preparing", "Starting", "Restarting"].includes(state)).length
  }
}

const mainUrl = (worktree: WorktreeView) => {
  const http = Object.entries(worktree.services).flatMap(([name, view]) => {
    const url = serviceUrl(view)
    return url ? [[name, url] as const] : []
  })
  const preferred = http.find(([name]) => ["portal", "web", "shop", "app", "console", "api"].includes(name)) ?? http[0]
  return preferred?.[1].replace("http://", "") ?? ""
}

const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))

const healthOf = (worktree: WorktreeView) => {
  const { total, settled, failed, busy } = counts(worktree)
  if (failed > 0) return { color: theme.failed, label: `${settled}/${total} · ${failed} failed` }
  if (busy > 0) return { color: theme.starting, label: `${settled}/${total} · ${busy} starting` }
  return { color: theme.ready, label: `${settled}/${total} ready` }
}

const Health = ({ worktree }: { readonly worktree: WorktreeView }) => {
  const { color, label } = healthOf(worktree)
  return h(Text, { color }, pad(label, 20))
}

const WorktreeLine = ({
  worktree,
  usage,
  selected
}: {
  readonly worktree: WorktreeView
  readonly usage: Usage
  readonly selected: boolean
}) => {
  const infra = Object.values(worktree.infra)
  const infraReady = infra.filter((view) => view._tag === "InfraReady").length
  const colors = selected ? { backgroundColor: theme.selectedBg } : {}

  return h(
    Text,
    { wrap: "truncate", ...colors },
    h(Text, { color: theme.accent }, selected ? "▸ " : "  "),
    h(Text, { color: theme.muted }, pad(worktree.project, 12)),
    h(Text, { bold: true, color: theme.text }, pad(worktree.branch, 22)),
    h(Health, { worktree }),
    h(Text, { color: infraReady === infra.length ? theme.muted : theme.starting }, pad(`${infraReady}/${infra.length}`, 8)),
    h(Text, { color: theme.text }, pad(formatCpu(usage), 7)),
    h(Text, { color: theme.text }, pad(formatMem(usage), 8)),
    h(Text, { color: theme.accent }, mainUrl(worktree))
  )
}

const sharedInfra = (worktrees: ReadonlyArray<WorktreeView>) => {
  const all = worktrees.flatMap((worktree) =>
    Object.entries(worktree.infra)
      .filter(([, view]) => view.scope === "shared")
      .map(([name, view]) => ({ name, view, worktree: worktree.id }))
  )
  const keyOf = (item: (typeof all)[number]) => `${item.name}|${"instance" in item.view ? item.view.instance : ""}`
  return [...new Set(all.map(keyOf))].map((key) => {
    const users = all.filter((item) => keyOf(item) === key)
    return { ...users[0]!, users: users.length }
  })
}

export const Home = ({ snapshot, usage, daemon, rows, onOpen, onStop, onDashboard, onQuit }: Props) => {
  const [selected, setSelected] = useState(0)
  const worktrees = Object.values(snapshot).sort(branchOrder)
  const usageOf = (worktree: WorktreeView) => sumUsage(pidsOf(worktree).map((pid) => usageFor(usage, pid)))
  const total = sumUsage(worktrees.map(usageOf))
  const processes = worktrees.reduce((sum, worktree) => sum + Object.keys(worktree.services).length, 0)
  const current = worktrees[Math.min(selected, worktrees.length - 1)]
  const listRows = Math.max(3, rows - firstRow - bottomHeight - 1)
  const offset = Math.max(0, selected - (listRows - 1))
  const shared = sharedInfra(worktrees)

  const move = (step: number) => setSelected((index) => Math.max(0, Math.min(worktrees.length - 1, index + step)))
  const open = () => (current ? onOpen(current.id) : undefined)
  const stop = () => (current ? onStop(current.id) : undefined)

  const buttons = place([
    { label: " ⏎ open ", action: open },
    { label: " ■ stop ", action: stop },
    { label: " ↗ dashboard ", action: onDashboard },
    { label: " q quit ", action: onQuit }
  ])

  const onMouse = (event: Mouse) => {
    if (isWheel(event)) return move(isWheelDown(event) ? 1 : -1)
    if (!isClick(event)) return
    if (event.y === rows) return clickedButton(buttons, event.x)?.action()
    if (event.y < firstRow || event.y >= firstRow + listRows) return
    const index = offset + event.y - firstRow
    if (index >= worktrees.length) return
    setSelected(index)
    onOpen(worktrees[index]!.id)
  }

  useMouse(onMouse)

  useInput((input, key) => {
    if (isMouseInput(input)) return
    if (input === "q" || (key.ctrl && input === "c")) return onQuit()
    if (key.upArrow || input === "k") return move(-1)
    if (key.downArrow || input === "j") return move(1)
    if (key.return || key.rightArrow || input === "l") return open()
    if (input === "s") return stop()
    if (input === "d") return onDashboard()
  })

  return h(
    Box,
    { flexDirection: "column", height: rows },
    h(
      Text,
      { wrap: "truncate" },
      h(Text, { bold: true, color: theme.accent }, "forkyard  "),
      h(
        Text,
        { color: theme.text },
        `${worktrees.length} worktrees · ${new Set(worktrees.map((w) => w.project)).size} repos · ${processes} processes`
      ),
      h(Text, { color: theme.muted }, `   CPU ${formatCpu(total)}   memory ${formatMem(total)}`)
    ),
    h(
      Box,
      { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: theme.border, paddingX: 1, overflow: "hidden" },
      h(
        Text,
        { color: theme.faint, wrap: "truncate" },
        `  ${pad("REPO", 12)}${pad("BRANCH", 22)}${pad("SERVICES", 20)}${pad("INFRA", 8)}${pad("CPU", 7)}${pad("MEMORY", 8)}OPEN AT`
      ),
      worktrees.length === 0 ? h(Text, { color: theme.muted }, "  Nothing running. Run forkyard up in a checkout.") : null,
      ...worktrees
        .slice(offset, offset + listRows)
        .map((worktree, index) =>
          h(WorktreeLine, { key: worktree.id, worktree, usage: usageOf(worktree), selected: index + offset === selected })
        )
    ),
    h(
      Box,
      { height: bottomHeight },
      h(
        Box,
        {
          width: 48,
          flexShrink: 0,
          flexDirection: "column",
          borderStyle: "round",
          borderColor: theme.border,
          paddingX: 1,
          overflow: "hidden"
        },
        h(Text, { bold: true, color: theme.text }, "shared infra"),
        ...shared
          .slice(0, bottomHeight - 3)
          .map((item) =>
            h(
              Text,
              { key: `${item.name}${item.worktree}`, wrap: "truncate" },
              h(Text, { color: stateColor(item.view._tag) }, "● "),
              h(Text, { color: theme.text }, pad(item.name, 20)),
              h(Text, { color: theme.muted }, `used by ${item.users}`)
            )
          )
      ),
      h(
        Box,
        { flexGrow: 1, flexDirection: "column", borderStyle: "round", borderColor: theme.border, paddingX: 1, overflow: "hidden" },
        h(Text, { bold: true, color: theme.text }, "forkyard log"),
        ...daemon
          .slice(-(bottomHeight - 3))
          .map((line, index) => h(Text, { key: `${index}`, color: theme.muted, wrap: "truncate" }, line.text))
      )
    ),
    h(ButtonBar, { buttons, note: "click a worktree to open it · ↑↓ ⏎ s d q" })
  )
}
