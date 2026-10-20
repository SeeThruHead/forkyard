import { Box, Text, useInput } from "ink"
import { type ReactNode, useMemo, useState } from "react"
import type { EnvVar, InfraView, ServiceView, UsageMap, WorktreeView } from "../src/Model.ts"
import { runOf, serviceUrl, viewLabel } from "../src/Model.ts"
import { keyOfInfra, type Line, type Logs, separator } from "./Feeds.ts"
import { ButtonBar } from "./ButtonBar.tsx"
import { clickedButton, isClick, isMouseInput, isWheel, isWheelDown, type Mouse, place, useMouse } from "./Mouse.ts"
import { formatCpu, formatMem, sharedLabel, usageFor } from "../src/Model.ts"
import { keyColor, stateColor, theme } from "./Theme.ts"

export type Entry =
  | { readonly _tag: "All" }
  | { readonly _tag: "Processes" }
  | { readonly _tag: "Daemon" }
  | { readonly _tag: "Infra"; readonly name: string; readonly view: InfraView }
  | { readonly _tag: "Service"; readonly name: string; readonly view: ServiceView }

type Props = {
  readonly worktree: WorktreeView
  readonly usage: UsageMap
  readonly logs: Logs
  readonly daemon: ReadonlyArray<Line>
  readonly rows: number
  readonly position: string
  readonly onBack: () => void
  readonly onSwitch: (step: number) => void
  readonly onRestart: (service: string) => void
  readonly onEnv: (service: string) => Promise<ReadonlyArray<EnvVar>>
  readonly onOpenUrl: (url: string) => void
  readonly onQuit: () => void
}

const sidebarWidth = 40
const firstRow = 3

const entriesOf = (worktree: WorktreeView): ReadonlyArray<Entry> => [
  { _tag: "All" },
  { _tag: "Processes" },
  ...Object.entries(worktree.infra).map(([name, view]): Entry => ({ _tag: "Infra", name, view })),
  ...Object.entries(worktree.services).map(([name, view]): Entry => ({ _tag: "Service", name, view })),
  { _tag: "Daemon" }
]

const keyOf = (entry: Entry) => {
  if (entry._tag === "All") return "all"
  if (entry._tag === "Processes") return "processes"
  if (entry._tag === "Daemon") return "forkyard"
  if (entry._tag === "Infra") return keyOfInfra(entry.name)
  return entry.name
}

type Look = { readonly label: string; readonly icon: string; readonly color: string; readonly state: string }

const lookOf = (entry: Entry): Look => {
  if (entry._tag === "All") return { label: "all output", icon: "◆", color: theme.accent, state: "" }
  if (entry._tag === "Processes") return { label: "processes", icon: "▦", color: theme.accent, state: "" }
  if (entry._tag === "Daemon") return { label: "forkyard", icon: "⚙", color: theme.muted, state: "daemon" }
  if (entry._tag === "Infra") return { label: entry.name, icon: "◇", color: stateColor(entry.view._tag), state: entry.view.scope }
  return { label: entry.name, icon: "●", color: stateColor(entry.view.state._tag), state: viewLabel(entry.view) }
}

const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))

const linesFor = (entry: Entry, logs: Logs, daemon: ReadonlyArray<Line>): ReadonlyArray<Line> => {
  if (entry._tag === "Daemon") return daemon
  if (entry._tag !== "All") return logs.byKey[keyOf(entry)] ?? []
  return Object.values(logs.byKey)
    .flat()
    .filter((line) => !separator(line.text))
    .sort((a, b) => a.at - b.at)
    .slice(-5000)
}

const matches = (filter: string) => (line: Line) => filter === "" || line.text.toLowerCase().includes(filter.toLowerCase())

const EntryRow = ({ entry, selected }: { readonly entry: Entry; readonly selected: boolean }) => {
  const { label, icon, color, state } = lookOf(entry)
  return (
    <Text wrap="truncate" {...(selected ? { backgroundColor: theme.selectedBg } : {})}>
      <Text color={color}>{`${icon} `}</Text>
      <Text color={theme.text} bold={selected}>
        {pad(label, 22)}
      </Text>
      <Text color={entry._tag === "Service" ? color : theme.faint}>{pad(state, 11)}</Text>
    </Text>
  )
}

const Highlighted = ({ text, filter }: { readonly text: string; readonly filter: string }): ReactNode => {
  const at = filter === "" ? -1 : text.toLowerCase().indexOf(filter.toLowerCase())
  if (at === -1) return text
  return (
    <Text>
      {text.slice(0, at)}
      <Text backgroundColor={theme.matchBg} color={theme.matchText}>
        {text.slice(at, at + filter.length)}
      </Text>
      {text.slice(at + filter.length)}
    </Text>
  )
}

const LogLine = ({ line, showKey, filter }: { readonly line: Line; readonly showKey: boolean; readonly filter: string }) => (
  <Text wrap="truncate">
    {showKey ? <Text color={keyColor(line.key)}>{`${pad(line.key.replace(/^infra:/, ""), 18)} `}</Text> : null}
    <Text color={separator(line.text) ? theme.faint : theme.text}>
      <Highlighted text={line.text} filter={filter} />
    </Text>
  </Text>
)

const EnvTable = ({ vars }: { readonly vars: ReadonlyArray<EnvVar> }) => (
  <Box flexDirection="column">
    <Text color={theme.faint}>{`${pad("VARIABLE", 34)}${pad("FROM", 30)}VALUE`}</Text>
    {vars.map((entry) => (
      <Text key={entry.key} wrap="truncate">
        <Text color={theme.accent}>{pad(entry.key, 34)}</Text>
        <Text color={theme.muted}>{pad(entry.source, 30)}</Text>
        <Text color={theme.text}>{entry.value}</Text>
        {entry.replaced ? <Text color={theme.faint}>{`  (was ${entry.replaced})`}</Text> : null}
      </Text>
    ))}
  </Box>
)

const InfraLine = ({ name, view }: { readonly name: string; readonly view: InfraView }) => (
  <Text wrap="truncate">
    <Text color={theme.text}>{pad(name, 22)}</Text>
    <Text color={theme.muted}>{pad("infra", 8)}</Text>
    <Text color={stateColor(view._tag)}>{pad(view._tag.replace("Infra", "").toLowerCase(), 12)}</Text>
    <Text color={theme.muted}>{pad(view.scope, 37)}</Text>
    <Text color={theme.accent}>{"url" in view ? (view.url ?? "") : ""}</Text>
  </Text>
)

const ServiceLine = ({ name, view, usage }: { readonly name: string; readonly view: ServiceView; readonly usage: UsageMap }) => {
  const run = runOf(view.state)
  const use = run ? usageFor(usage, run.pid) : undefined
  const shared = sharedLabel(view)
  const note = [shared, serviceUrl(view) ?? ("reason" in view.state ? view.state.reason : "")].filter(Boolean).join("  ")
  const figures = shared ? theme.shared : theme.text
  return (
    <Text wrap="truncate">
      <Text color={shared ? theme.shared : theme.text}>{pad(name, 22)}</Text>
      <Text color={theme.muted}>{pad(view._tag.toLowerCase(), 8)}</Text>
      <Text color={shared ? theme.shared : stateColor(view.state._tag)}>{pad(viewLabel(view), 12)}</Text>
      <Text color={theme.muted}>{pad(run ? `#${run.run}` : "", 6)}</Text>
      <Text color={theme.muted}>{pad(run ? String(run.pid) : "", 8)}</Text>
      <Text color={figures}>{pad(formatCpu(use), 7)}</Text>
      <Text color={figures}>{pad(formatMem(use), 9)}</Text>
      <Text color={view.state._tag === "Failed" ? theme.failed : theme.accent}>{note}</Text>
    </Text>
  )
}

const ProcessTable = ({ worktree, usage }: { readonly worktree: WorktreeView; readonly usage: UsageMap }) => (
  <Box flexDirection="column">
    <Text color={theme.faint}>
      {`${pad("NAME", 22)}${pad("KIND", 8)}${pad("STATE", 12)}${pad("RUN", 6)}${pad("PID", 8)}${pad("CPU", 7)}${pad("MEMORY", 9)}URL / REASON`}
    </Text>
    {Object.entries(worktree.infra).map(([name, view]) => (
      <InfraLine key={`infra-${name}`} name={name} view={view} />
    ))}
    {Object.entries(worktree.services).map(([name, view]) => (
      <ServiceLine key={name} name={name} view={view} usage={usage} />
    ))}
  </Box>
)

export const Worktree = ({
  worktree,
  usage,
  logs,
  daemon,
  rows,
  position,
  onBack,
  onSwitch,
  onRestart,
  onEnv,
  onOpenUrl,
  onQuit
}: Props) => {
  const [selected, setSelected] = useState(0)
  const [filter, setFilter] = useState("")
  const [typing, setTyping] = useState(false)
  const [scroll, setScroll] = useState(0)
  const [env, setEnv] = useState<ReadonlyArray<EnvVar> | undefined>(undefined)
  const [notice, setNotice] = useState("")

  const entries = entriesOf(worktree)
  const entry = entries[Math.min(selected, entries.length - 1)] ?? { _tag: "All" }
  const visible = useMemo(() => linesFor(entry, logs, daemon).filter(matches(filter)), [entry, logs, daemon, filter])
  const height = Math.max(5, rows - 6)
  const end = Math.max(0, visible.length - scroll)
  const shown = visible.slice(Math.max(0, end - height), end)
  const listRows = Math.max(3, rows - 4)
  const listOffset = Math.max(0, selected - (listRows - 1))
  const service = entry._tag === "Service" ? entry : undefined

  const select = (index: number) => {
    if (index < 0 || index >= entries.length) return
    setSelected(index)
    setScroll(0)
    setEnv(undefined)
  }
  const move = (step: number) => select(Math.max(0, Math.min(entries.length - 1, selected + step)))
  const restart = () => {
    if (!service) return setNotice("pick a service to restart")
    setNotice(`restarting ${service.name}…`)
    onRestart(service.name)
  }
  const toggleEnv = () => {
    if (env) return setEnv(undefined)
    if (!service) return setNotice("pick a service to see its env")
    void onEnv(service.name).then(setEnv, (error: unknown) => setNotice(String(error)))
  }
  const open = () => {
    const url = service ? serviceUrl(service.view) : undefined
    if (url) onOpenUrl(url)
  }
  const clearFilter = () => {
    setFilter("")
    setTyping(false)
  }

  const buttons = place([
    { label: " ◀ worktrees ", action: onBack },
    { label: " ↻ restart ", action: restart },
    { label: " ≡ env ", action: toggleEnv },
    { label: " ↗ open ", action: open },
    { label: " / filter ", action: () => setTyping(true) },
    { label: " ✕ clear ", action: clearFilter },
    { label: " ⤓ follow ", action: () => setScroll(0) },
    { label: " q quit ", action: onQuit }
  ])
  const header = { previous: 24, next: 26 }

  const onMouse = (event: Mouse) => {
    const inSidebar = event.x <= sidebarWidth
    if (isWheel(event) && inSidebar) return move(isWheelDown(event) ? 1 : -1)
    if (isWheel(event))
      return setScroll((current) => (isWheelDown(event) ? Math.max(0, current - 3) : Math.min(visible.length, current + 3)))
    if (!isClick(event)) return
    if (event.y === 1 && event.x >= 10 && event.x <= 22) return onBack()
    if (event.y === 1 && Math.abs(event.x - header.previous) <= 1) return onSwitch(-1)
    if (event.y === 1 && Math.abs(event.x - header.next) <= 1) return onSwitch(1)
    if (event.y === rows) return clickedButton(buttons, event.x)?.action()
    if (inSidebar && event.y >= firstRow && event.y < firstRow + listRows) return select(listOffset + event.y - firstRow)
    if (!inSidebar && event.y === firstRow && filter) return clearFilter()
  }

  useMouse(onMouse)

  useInput((input, key) => {
    if (isMouseInput(input)) return
    if (typing && key.return) return setTyping(false)
    if (typing && key.escape) return clearFilter()
    if (typing && (key.backspace || key.delete)) return setFilter((current) => current.slice(0, -1))
    if (typing) return setFilter((current) => current + input)
    if (input === "q" || (key.ctrl && input === "c")) return onQuit()
    if (key.escape && filter) return clearFilter()
    if (key.escape || key.leftArrow || input === "h") return onBack()
    if (key.upArrow || input === "k") return move(-1)
    if (key.downArrow || input === "j") return move(1)
    if (input === "/") return setTyping(true)
    if (input === "r") return restart()
    if (input === "e") return toggleEnv()
    if (input === "o") return open()
    if (input === "[") return onSwitch(-1)
    if (input === "]") return onSwitch(1)
    if (input === "u" || key.pageUp) return setScroll((current) => Math.min(visible.length, current + height))
    if (input === "d" || key.pageDown) return setScroll((current) => Math.max(0, current - height))
    if (input === "G") return setScroll(0)
  })

  const detail = service
    ? [serviceUrl(service.view), "reason" in service.view.state ? service.view.state.reason : undefined].filter(Boolean).join("  ")
    : ""
  const main = () => {
    if (env) return <EnvTable vars={env} />
    if (entry._tag === "Processes") return <ProcessTable worktree={worktree} usage={usage} />
    return (
      <Box flexDirection="column">
        {shown.map((line, index) => (
          <LogLine key={index} line={line} showKey={entry._tag === "All"} filter={filter} />
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" height={rows}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>
          {"forkyard "}
        </Text>
        <Text color={theme.muted}>{" ◀ worktrees  "}</Text>
        <Text color={theme.accent}>{"◀ ▶  "}</Text>
        <Text bold color={keyColor(worktree.project)}>
          {worktree.project}
        </Text>
        <Text color={theme.faint}>{" › "}</Text>
        <Text bold color="#ffffff">
          {worktree.branch}
        </Text>
        {worktree.profile === "default" ? null : <Text color={theme.restarting}>{`  profile ${worktree.profile}`}</Text>}
        <Text color={theme.muted}>{`  ${position}   ${worktree.root}`}</Text>
      </Text>
      <Box flexGrow={1}>
        <Box
          width={sidebarWidth}
          flexShrink={0}
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
          overflow="hidden"
        >
          {entries.slice(listOffset, listOffset + listRows).map((item, index) => (
            <EntryRow key={keyOf(item)} entry={item} selected={index + listOffset === selected} />
          ))}
        </Box>
        <Box
          flexGrow={1}
          flexDirection="column"
          borderStyle="round"
          borderColor={typing ? theme.starting : theme.border}
          paddingX={1}
          overflow="hidden"
        >
          <Text wrap="truncate">
            <Text bold color={theme.text}>
              {lookOf(entry).label}
            </Text>
            <Text color={theme.accent}>{`  ${detail}`}</Text>
            {filter ? <Text color={theme.starting}>{`  filter "${filter}" · ${visible.length} lines · ✕`}</Text> : null}
            {scroll > 0 ? <Text color={theme.restarting}>{`  scrolled up ${scroll} · ⤓ follow`}</Text> : null}
          </Text>
          {main()}
        </Box>
      </Box>
      {typing ? (
        <Text color={theme.starting} wrap="truncate">{` /${filter}▏  enter to keep, esc to clear`}</Text>
      ) : (
        <ButtonBar buttons={buttons} note={notice || "click or ↑↓ · esc back"} />
      )}
    </Box>
  )
}
