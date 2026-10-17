import { Box, Text, useInput } from "ink"
import { createElement as h, useState } from "react"
import type { WorktreeId } from "../src/Ids.ts"
import { runOf, serviceUrl, type ServiceView, type Snapshot, type UsageMap, type WorktreeView } from "../src/Model.ts"
import type { Line } from "./Feeds.ts"
import { ButtonBar, clickedButton, isClick, isMouseInput, isWheel, isWheelDown, type Mouse, place, useMouse } from "./Mouse.ts"
import { formatCpu, formatMem, sumUsage, usageFor } from "./Stats.ts"
import { keyColor, stateColor, theme } from "./Theme.ts"

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
const firstRow = 3

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

type Row =
  | { readonly _tag: "Repo"; readonly project: string; readonly worktrees: ReadonlyArray<WorktreeView>; readonly open: boolean }
  | { readonly _tag: "Branch"; readonly worktree: WorktreeView; readonly expanded: boolean }
  | { readonly _tag: "Process"; readonly worktree: WorktreeView; readonly name: string; readonly view: ServiceView }

const rowsOf = (
  worktrees: ReadonlyArray<WorktreeView>,
  collapsed: ReadonlyArray<string>,
  expanded: ReadonlyArray<string>
): ReadonlyArray<Row> =>
  [...new Set(worktrees.map((worktree) => worktree.project))].flatMap((project) => {
    const members = worktrees.filter((worktree) => worktree.project === project)
    const open = !collapsed.includes(project)
    const branches = open
      ? members.flatMap((worktree): ReadonlyArray<Row> => {
          const isExpanded = expanded.includes(worktree.id)
          const processes = isExpanded
            ? Object.entries(worktree.services).map(([name, view]): Row => ({ _tag: "Process", worktree, name, view }))
            : []
          return [{ _tag: "Branch", worktree, expanded: isExpanded }, ...processes]
        })
      : []
    return [{ _tag: "Repo", project, worktrees: members, open } satisfies Row, ...branches]
  })

const rowKey = (row: Row) => {
  if (row._tag === "Repo") return row.project
  if (row._tag === "Branch") return row.worktree.id
  return `${row.worktree.id}/${row.name}`
}

const toggled = (list: ReadonlyArray<string>, item: string) =>
  list.includes(item) ? list.filter((other) => other !== item) : [...list, item]

const repoTone = (worktrees: ReadonlyArray<WorktreeView>) => {
  const all = worktrees.map(counts)
  const failed = all.reduce((sum, item) => sum + item.failed, 0)
  const settled = all.reduce((sum, item) => sum + item.settled, 0)
  const total = all.reduce((sum, item) => sum + item.total, 0)
  if (failed > 0) return { color: theme.failed, label: `${settled}/${total} · ${failed} failed` }
  if (settled < total) return { color: theme.starting, label: `${settled}/${total}` }
  return { color: theme.ready, label: `${settled}/${total}` }
}

type RowProps = { readonly row: Row; readonly usage: UsageMap; readonly selected: boolean }

const RowLine = ({ row, usage, selected }: RowProps) => {
  const background = selected ? { backgroundColor: theme.selectedBg } : {}

  if (row._tag === "Repo") {
    const tone = repoTone(row.worktrees)
    const resources = sumUsage(row.worktrees.map((worktree) => sumUsage(pidsOf(worktree).map((pid) => usageFor(usage, pid)))))
    return h(
      Text,
      { wrap: "truncate", ...background },
      h(Text, { color: theme.muted }, row.open ? "▾ " : "▸ "),
      h(Text, { bold: true, color: keyColor(row.project) }, row.project),
      h(Text, { color: theme.muted }, `  ${row.worktrees.length} ${row.worktrees.length === 1 ? "branch" : "branches"}  `),
      h(Text, { color: tone.color }, `${tone.label}  `),
      h(Text, { color: theme.text }, `${formatCpu(resources)}  ${formatMem(resources)}`)
    )
  }

  if (row._tag === "Branch") {
    const { color, label } = healthOf(row.worktree)
    const infra = Object.values(row.worktree.infra)
    const infraReady = infra.filter((view) => view._tag === "InfraReady").length
    const resources = sumUsage(pidsOf(row.worktree).map((pid) => usageFor(usage, pid)))
    return h(
      Text,
      { wrap: "truncate", ...background },
      h(Text, { color: theme.muted }, row.expanded ? "  ▾ " : "  ▸ "),
      h(Text, { bold: true, color: theme.text }, pad(row.worktree.branch, 22)),
      h(Text, { color }, pad(label, 20)),
      h(Text, { color: infraReady === infra.length ? theme.muted : theme.starting }, pad(`infra ${infraReady}/${infra.length}`, 13)),
      h(Text, { color: theme.text }, pad(formatCpu(resources), 6)),
      h(Text, { color: theme.text }, pad(formatMem(resources), 7)),
      h(Text, { color: theme.accent }, mainUrl(row.worktree))
    )
  }

  const run = runOf(row.view.state)
  const use = run ? usageFor(usage, run.pid) : undefined
  const note = serviceUrl(row.view)?.replace("http://", "") ?? ("reason" in row.view.state ? row.view.state.reason : "")
  return h(
    Text,
    { wrap: "truncate", ...background },
    h(Text, { color: stateColor(row.view.state._tag) }, "      ● "),
    h(Text, { color: theme.text }, pad(row.name, 22)),
    h(Text, { color: stateColor(row.view.state._tag) }, pad(row.view.state._tag.toLowerCase(), 11)),
    h(Text, { color: theme.muted }, pad(run ? `#${run.run}` : "", 6)),
    h(Text, { color: theme.text }, pad(formatCpu(use), 6)),
    h(Text, { color: theme.text }, pad(formatMem(use), 7)),
    h(Text, { color: row.view.state._tag === "Failed" ? theme.failed : theme.accent }, note)
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
  const [collapsed, setCollapsed] = useState<ReadonlyArray<string>>([])
  const [expanded, setExpanded] = useState<ReadonlyArray<string>>([])
  const worktrees = Object.values(snapshot).sort(branchOrder)
  const list = rowsOf(worktrees, collapsed, expanded)
  const total = sumUsage(worktrees.flatMap(pidsOf).map((pid) => usageFor(usage, pid)))
  const processes = worktrees.reduce((sum, worktree) => sum + Object.keys(worktree.services).length, 0)
  const index = Math.min(selected, Math.max(0, list.length - 1))
  const current = list[index]
  const listRows = Math.max(3, rows - firstRow - bottomHeight)
  const offset = Math.max(0, index - (listRows - 1))
  const shared = sharedInfra(worktrees)

  const move = (step: number) => setSelected(Math.max(0, Math.min(list.length - 1, index + step)))
  const activate = (row: Row | undefined) => {
    if (!row) return
    if (row._tag === "Repo") return setCollapsed((all) => toggled(all, row.project))
    onOpen(row.worktree.id)
  }
  const expand = (row: Row | undefined, open: boolean) => {
    if (row?._tag !== "Branch") return
    if (row.expanded === open) return
    setExpanded((all) => toggled(all, row.worktree.id))
  }
  const stop = () => {
    if (current?._tag === "Branch" || current?._tag === "Process") onStop(current.worktree.id)
  }

  const buttons = place([
    { label: " ⏎ open ", action: () => activate(current) },
    { label: " ■ stop ", action: stop },
    { label: " ↗ dashboard ", action: onDashboard },
    { label: " q quit ", action: onQuit }
  ])

  const onMouse = (event: Mouse) => {
    if (isWheel(event)) return move(isWheelDown(event) ? 1 : -1)
    if (!isClick(event)) return
    if (event.y === rows) return clickedButton(buttons, event.x)?.action()
    if (event.y < firstRow || event.y >= firstRow + listRows) return
    const at = offset + event.y - firstRow
    const row = list[at]
    if (!row) return
    setSelected(at)
    if (row._tag === "Branch" && event.x <= 7) return setExpanded((all) => toggled(all, row.worktree.id))
    activate(row)
  }

  useMouse(onMouse)

  useInput((input, key) => {
    if (isMouseInput(input)) return
    if (input === "q" || (key.ctrl && input === "c")) return onQuit()
    if (key.upArrow || input === "k") return move(-1)
    if (key.downArrow || input === "j") return move(1)
    if (key.rightArrow || input === "l") return expand(current, true)
    if (key.leftArrow || input === "h") return expand(current, false)
    if (input === " " && current?._tag === "Branch") return setExpanded((all) => toggled(all, current.worktree.id))
    if (key.return) return activate(current)
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
        `${worktrees.length} worktrees · ${new Set(worktrees.map((worktree) => worktree.project)).size} repos · ${processes} processes`
      ),
      h(Text, { color: theme.muted }, `   CPU ${formatCpu(total)}   memory ${formatMem(total)}`)
    ),
    h(
      Box,
      { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: theme.border, paddingX: 1, overflow: "hidden" },
      worktrees.length === 0 ? h(Text, { color: theme.muted }, "Nothing running. Run forkyard up in a checkout.") : null,
      ...list.slice(offset, offset + listRows).map((row, at) =>
        h(RowLine, {
          key: rowKey(row),
          row,
          usage,
          selected: at + offset === index
        })
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
        ...daemon.slice(-(bottomHeight - 3)).map((line, at) => h(Text, { key: `${at}`, color: theme.muted, wrap: "truncate" }, line.text))
      )
    ),
    h(ButtonBar, { buttons, note: "⏎ open · → expand · ← collapse · click ▸ to expand" })
  )
}
