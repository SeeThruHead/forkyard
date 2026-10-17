import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { ownerOfInfra, ownerOfWorktree, type RunId, ServiceName, type WorktreeId } from "../../src/Ids.ts"
import { type InfraView, runOf, serviceUrl, type ServiceView, type UsageMap, type WorktreeView } from "../../src/Model.ts"
import { allLogsAtom, daemonLogAtom, envAtom, envKey, followKey, restartAtom, runLogAtom, runsAtom, runsKey } from "./forkyard.ts"
import { formatCpu, formatMem, keyColor } from "./format.ts"
import { go } from "./ui.tsx"

type Entry =
  | { readonly _tag: "All" }
  | { readonly _tag: "Processes" }
  | { readonly _tag: "Daemon" }
  | { readonly _tag: "Infra"; readonly name: string; readonly view: InfraView }
  | { readonly _tag: "Service"; readonly name: string; readonly view: ServiceView }

type Line = { readonly key: string; readonly text: string }

const keyOf = (entry: Entry) => {
  if (entry._tag === "All") return "all"
  if (entry._tag === "Processes") return "processes"
  if (entry._tag === "Daemon") return "forkyard"
  if (entry._tag === "Infra") return `infra:${entry.name}`
  return entry.name
}

const entriesOf = (worktree: WorktreeView): ReadonlyArray<Entry> => [
  { _tag: "All" },
  { _tag: "Processes" },
  ...Object.entries(worktree.infra).map(([name, view]): Entry => ({ _tag: "Infra", name, view })),
  ...Object.entries(worktree.services).map(([name, view]): Entry => ({ _tag: "Service", name, view })),
  { _tag: "Daemon" }
]

const lookOf = (entry: Entry) => {
  if (entry._tag === "All") return { icon: "◆", label: "all output", state: "", tone: "" }
  if (entry._tag === "Processes") return { icon: "▦", label: "processes", state: "", tone: "" }
  if (entry._tag === "Daemon") return { icon: "⚙", label: "forkyard", state: "daemon", tone: "faint" }
  if (entry._tag === "Infra") return { icon: "◇", label: entry.name, state: entry.view.scope, tone: `c-${entry.view._tag}` }
  return { icon: "●", label: entry.name, state: entry.view.state._tag.toLowerCase(), tone: `c-${entry.view.state._tag}` }
}

const Highlighted = ({ text, filter }: { readonly text: string; readonly filter: string }): ReactNode => {
  const at = filter === "" ? -1 : text.toLowerCase().indexOf(filter.toLowerCase())
  if (at === -1) return text
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + filter.length)}</mark>
      {text.slice(at + filter.length)}
    </>
  )
}

const LogView = ({
  lines,
  filter,
  showKey
}: {
  readonly lines: ReadonlyArray<Line>
  readonly filter: string
  readonly showKey: boolean
}) => {
  const box = useRef<HTMLPreElement>(null)
  const [following, setFollowing] = useState(true)
  const visible = useMemo(
    () => lines.filter((line) => filter === "" || line.text.toLowerCase().includes(filter.toLowerCase())),
    [lines, filter]
  )

  useEffect(() => {
    if (following) box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [visible.length, following])

  const onScroll = () => {
    const element = box.current
    if (!element) return
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
  }

  if (visible.length === 0) return <p className="empty">{filter ? `No lines match "${filter}".` : "No output yet."}</p>
  return (
    <pre className="logview" ref={box} onScroll={onScroll}>
      {visible.map((line, index) => (
        <div key={index} className={line.text.startsWith("── ") ? "separator" : undefined}>
          {showKey ? (
            <span className="key" style={{ color: keyColor(line.key) }}>
              {line.key}
            </span>
          ) : null}
          <Highlighted text={line.text} filter={filter} />
        </div>
      ))}
    </pre>
  )
}

const resultLines = <A,>(result: AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>) => (AsyncResult.isSuccess(result) ? result.value : [])

const AllOutput = ({ worktree, filter }: { readonly worktree: WorktreeView; readonly filter: string }) => {
  const runs = Object.entries(worktree.services).flatMap(([name, view]) => {
    const run = runOf(view.state)
    return run ? [[name, run.runId] as const] : []
  })
  const lines = resultLines(useAtomValue(allLogsAtom(followKey(runs))))
  return <LogView lines={lines.map((line) => ({ key: line.key, text: line.line }))} filter={filter} showKey />
}

const RunOutput = ({ runId, filter }: { readonly runId: RunId; readonly filter: string }) => {
  const lines = resultLines(useAtomValue(runLogAtom(runId)))
  return <LogView lines={lines.map((line) => ({ key: "", text: line.line }))} filter={filter} showKey={false} />
}

const runLabel = (run: { readonly _tag: string; readonly exitCode?: number }) => {
  if (run._tag === "Running") return "running"
  if (run._tag === "Stopped") return "stopped"
  return `exited ${run.exitCode}`
}

const RunPicker = ({
  owner,
  service,
  version,
  current,
  onPick
}: {
  readonly owner: ReturnType<typeof ownerOfWorktree>
  readonly service: string
  readonly version: string
  readonly current: RunId | undefined
  readonly onPick: (runId: RunId) => void
}) => {
  const runs = resultLines(useAtomValue(runsAtom(runsKey(owner, service, version))))
  if (runs.length === 0) return null
  return (
    <select value={current ?? runs[0]!.id} onChange={(event) => onPick(runs.find((run) => String(run.id) === event.target.value)!.id)}>
      {runs.map((run) => (
        <option key={run.id} value={run.id}>
          run #{run.n} · {runLabel(run)}
        </option>
      ))}
    </select>
  )
}

const EnvView = ({ id, service, version }: { readonly id: WorktreeId; readonly service: string; readonly version: string }) => {
  const vars = resultLines(useAtomValue(envAtom(envKey(id, ServiceName.make(service), version))))
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>From</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {vars.map((entry) => (
            <tr key={entry.key}>
              <td>
                <code style={{ color: "var(--accent)" }}>{entry.key}</code>
              </td>
              <td className="dim">{entry.source}</td>
              <td>
                <code>{entry.value}</code>
                {entry.replaced ? <span className="faint"> (was {entry.replaced})</span> : null}
                {entry.warning ? <div className="c-Starting">{entry.warning}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const ProcessTable = ({ worktree, usage }: { readonly worktree: WorktreeView; readonly usage: UsageMap }) => (
  <div className="scroll">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Kind</th>
          <th>State</th>
          <th>Run</th>
          <th>PID</th>
          <th>CPU</th>
          <th>Memory</th>
          <th>URL / reason</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(worktree.infra).map(([name, view]) => (
          <tr key={`infra-${name}`} className="clickable" onClick={() => go(`wt/${worktree.id}/infra:${name}`)}>
            <td>{name}</td>
            <td className="dim">infra</td>
            <td className={`c-${view._tag}`}>{view._tag.replace("Infra", "").toLowerCase()}</td>
            <td className="dim" colSpan={4}>
              {view.scope}
            </td>
            <td>{"url" in view && view.url ? <a href={view.url}>{view.url.replace("http://", "")}</a> : null}</td>
          </tr>
        ))}
        {Object.entries(worktree.services).map(([name, view]) => {
          const run = runOf(view.state)
          const use = run ? usage[String(run.pid)] : undefined
          const url = serviceUrl(view)
          return (
            <tr key={name} className="clickable" onClick={() => go(`wt/${worktree.id}/${name}`)}>
              <td>{name}</td>
              <td className="dim">{view._tag.toLowerCase()}</td>
              <td className={`c-${view.state._tag}`}>{view.state._tag.toLowerCase()}</td>
              <td className="num dim">{run ? `#${run.run}` : ""}</td>
              <td className="num dim">{run?.pid ?? ""}</td>
              <td className="num">{formatCpu(use)}</td>
              <td className="num">{formatMem(use)}</td>
              <td>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                    {url.replace("http://", "")}
                  </a>
                ) : (
                  <span className="c-Failed">{"reason" in view.state ? view.state.reason : ""}</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  </div>
)

const DaemonOutput = ({ filter }: { readonly filter: string }) => {
  const lines = resultLines(useAtomValue(daemonLogAtom))
  return (
    <LogView lines={lines.map((line) => ({ key: "", text: `${line.level.padEnd(6)}${line.message}` }))} filter={filter} showKey={false} />
  )
}

const InfraRun = ({ name, instance, filter }: { readonly name: string; readonly instance: string; readonly filter: string }) => {
  const latest = resultLines(useAtomValue(runsAtom(runsKey(ownerOfInfra(instance), name, instance))))[0]
  if (!latest) return <p className="empty">No process output for {name}.</p>
  return <RunOutput runId={latest.id} filter={filter} />
}

const InfraOutput = ({ name, view, filter }: { readonly name: string; readonly view: InfraView; readonly filter: string }) => {
  if (view._tag !== "InfraReady") return <p className="empty">{name} is not running yet.</p>
  return <InfraRun name={name} instance={view.instance} filter={filter} />
}

const Sidebar = ({ worktree, selected }: { readonly worktree: WorktreeView; readonly selected: string }) => {
  const entries = entriesOf(worktree)
  const group = (title: string, items: ReadonlyArray<Entry>) => (
    <>
      <div className="entry-group">{title}</div>
      {items.map((entry) => {
        const look = lookOf(entry)
        return (
          <button
            key={keyOf(entry)}
            className={`entry ${keyOf(entry) === selected ? "on" : ""}`}
            onClick={() => go(`wt/${worktree.id}/${keyOf(entry)}`)}
          >
            <span className={`icon ${look.tone}`}>{look.icon}</span>
            <span className="label">{look.label}</span>
            <span className={`state ${entry._tag === "Service" ? look.tone : "faint"}`}>{look.state}</span>
          </button>
        )
      })}
    </>
  )
  return (
    <div className="panel sidebar">
      {group(
        "Views",
        entries.filter((entry) => entry._tag === "All" || entry._tag === "Processes")
      )}
      {group(
        "Infra",
        entries.filter((entry) => entry._tag === "Infra")
      )}
      {group(
        "Services",
        entries.filter((entry) => entry._tag === "Service")
      )}
      {group(
        "Daemon",
        entries.filter((entry) => entry._tag === "Daemon")
      )}
    </div>
  )
}

const ServicePane = ({
  worktree,
  name,
  view,
  filter,
  showEnv
}: {
  readonly worktree: WorktreeView
  readonly name: string
  readonly view: ServiceView
  readonly filter: string
  readonly showEnv: boolean
}) => {
  const run = runOf(view.state)
  const [picked, setPicked] = useState<RunId | undefined>(undefined)
  const version = `${run?.run ?? 0}-${view.state._tag}`
  const runId = picked ?? run?.runId
  if (showEnv) return <EnvView id={worktree.id} service={name} version={version} />
  return (
    <>
      <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
        <RunPicker owner={ownerOfWorktree(worktree.id)} service={name} version={version} current={runId} onPick={setPicked} />
      </div>
      {runId ? <RunOutput runId={runId} filter={filter} /> : <p className="empty">{name} has not started yet.</p>}
    </>
  )
}

export const WorktreePage = ({
  worktree,
  ids,
  usage,
  selected,
  showEnv
}: {
  readonly worktree: WorktreeView
  readonly ids: ReadonlyArray<WorktreeId>
  readonly usage: UsageMap
  readonly selected: string
  readonly showEnv: boolean
}) => {
  const restart = useAtomSet(restartAtom)
  const [filter, setFilter] = useState("")
  const entries = entriesOf(worktree)
  const entry = entries.find((item) => keyOf(item) === selected) ?? entries[0]!
  const look = lookOf(entry)
  const service = entry._tag === "Service" ? entry : undefined
  const url = service ? serviceUrl(service.view) : undefined
  const reason = service && "reason" in service.view.state ? service.view.state.reason : undefined
  const at = ids.indexOf(worktree.id)
  useEffect(() => {
    document.title = `${worktree.branch} · ${worktree.project} · forkyard`
  }, [worktree.branch, worktree.project])
  const step = (by: number) => go(`wt/${ids[(at + by + ids.length) % ids.length]}/${keyOf(entry)}`)

  const content = () => {
    if (entry._tag === "All") return <AllOutput worktree={worktree} filter={filter} />
    if (entry._tag === "Processes") return <ProcessTable worktree={worktree} usage={usage} />
    if (entry._tag === "Daemon") return <DaemonOutput filter={filter} />
    if (entry._tag === "Infra") return <InfraOutput name={entry.name} view={entry.view} filter={filter} />
    return <ServicePane key={entry.name} worktree={worktree} name={entry.name} view={entry.view} filter={filter} showEnv={showEnv} />
  }

  return (
    <div className="page">
      <div className="wt-header">
        <a href="#/">◀ Worktrees</a>
        <span className="stepper">
          <button className="button" title="Previous branch" disabled={ids.length < 2} onClick={() => step(-1)}>
            ◀
          </button>
          <button className="button" title="Next branch" disabled={ids.length < 2} onClick={() => step(1)}>
            ▶
          </button>
        </span>
        <span className="crumb">
          <span className="repo" style={{ borderColor: keyColor(worktree.project), color: keyColor(worktree.project) }}>
            {worktree.project}
          </span>
          <span className="sep">›</span>
          <span className="branch-name">{worktree.branch}</span>
        </span>
        <span className="dim">
          branch {at + 1} of {ids.length} in {worktree.project}
        </span>
        <code className="faint">{worktree.root}</code>
      </div>
      <div className="wt-body">
        <Sidebar worktree={worktree} selected={keyOf(entry)} />
        <div className="panel">
          <div className="pane-head">
            <span className={`title ${look.tone}`}>{look.icon}</span>
            <span className="title">{look.label}</span>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {url.replace("http://", "")}
              </a>
            ) : null}
            {reason ? <span className="c-Failed">{reason}</span> : null}
            <div className="tools">
              {service ? (
                <>
                  <button className="button" onClick={() => restart({ id: worktree.id, service: ServiceName.make(service.name) })}>
                    ↻ Restart
                  </button>
                  <button className="button" onClick={() => go(`wt/${worktree.id}/${service.name}${showEnv ? "" : "/env"}`)}>
                    ≡ {showEnv ? "Logs" : "Env"}
                  </button>
                  <button className="button" disabled={!url} onClick={() => url && window.open(url, "_blank")}>
                    ↗ Open
                  </button>
                </>
              ) : null}
              <input className="filter" placeholder="Filter output" value={filter} onChange={(event) => setFilter(event.target.value)} />
            </div>
          </div>
          {content()}
        </div>
      </div>
    </div>
  )
}
