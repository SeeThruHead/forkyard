import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { ServiceName } from "../../src/Ids.ts"
import { runOf, serviceUrl, type Snapshot, type UsageMap, type WorktreeView } from "../../src/Model.ts"
import { daemonLogAtom, restartAtom, stopAtom } from "./forkyard.ts"
import { counts, formatCpu, formatMem, healthOf, keyColor, mainUrl, sumUsage, usageOfWorktree, worktreeOrder } from "./format.ts"
import { go } from "./ui.tsx"

const sharedInfra = (worktrees: ReadonlyArray<WorktreeView>) => {
  const all = worktrees.flatMap((worktree) =>
    Object.entries(worktree.infra)
      .filter(([, view]) => view.scope === "shared")
      .map(([name, view]) => ({ name, view, key: `${name}|${"instance" in view ? view.instance : ""}` }))
  )
  return [...new Set(all.map((item) => item.key))].map((key) => {
    const users = all.filter((item) => item.key === key)
    return { ...users[0]!, users: users.length }
  })
}

const ProcessRows = ({ worktree, usage }: { readonly worktree: WorktreeView; readonly usage: UsageMap }) => {
  const restart = useAtomSet(restartAtom)
  return (
    <>
      {Object.entries(worktree.services).map(([name, view]) => {
        const run = runOf(view.state)
        const use = run ? usage[String(run.pid)] : undefined
        const url = serviceUrl(view)
        return (
          <tr key={name} className="process-row">
            <td />
            <td>
              <span className={`c-${view.state._tag}`}>● </span>
              {name}
            </td>
            <td className={`c-${view.state._tag}`}>
              {view.state._tag.toLowerCase()}
              {"reason" in view.state ? <span className="c-Failed"> · {view.state.reason}</span> : null}
            </td>
            <td className="num dim">{run ? `#${run.run}` : ""}</td>
            <td className="num">{formatCpu(use)}</td>
            <td className="num">{formatMem(use)}</td>
            <td>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  {url.replace("http://", "")}
                </a>
              ) : null}
            </td>
            <td style={{ textAlign: "right" }}>
              {view._tag === "Task" ? null : (
                <button className="button" onClick={() => restart({ id: worktree.id, service: ServiceName.make(name) })}>
                  ↻
                </button>
              )}
            </td>
          </tr>
        )
      })}
    </>
  )
}

const WorktreeRow = ({
  worktree,
  usage,
  expanded,
  onExpand
}: {
  readonly worktree: WorktreeView
  readonly usage: UsageMap
  readonly expanded: boolean
  readonly onExpand: () => void
}) => {
  const stop = useAtomSet(stopAtom)
  const health = healthOf(worktree)
  const infra = Object.values(worktree.infra)
  const infraReady = infra.filter((view) => view._tag === "InfraReady").length
  const total = usageOfWorktree(usage, worktree)
  const url = mainUrl(worktree)

  return (
    <tr className="clickable" onClick={() => go(`wt/${worktree.id}`)}>
      <td>
        <button
          className="expander"
          title={expanded ? "Hide processes" : "Show processes"}
          onClick={(event) => {
            event.stopPropagation()
            onExpand()
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
      </td>
      <td className="strong">{worktree.branch}</td>
      <td className={`health c-${health.state}`}>{health.label}</td>
      <td className={`num ${infraReady === infra.length ? "dim" : "c-Starting"}`}>
        {infraReady}/{infra.length}
      </td>
      <td className="num">{formatCpu(total)}</td>
      <td className="num">{formatMem(total)}</td>
      <td>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
            {url.replace("http://", "")}
          </a>
        ) : null}
      </td>
      <td style={{ textAlign: "right" }}>
        <button
          className="button danger"
          onClick={(event) => {
            event.stopPropagation()
            stop(worktree.id)
          }}
        >
          ■ Stop
        </button>
      </td>
    </tr>
  )
}

const levelTone = (level: string) => {
  if (level === "Warn") return "c-Starting"
  if (level === "Error") return "c-Failed"
  return "faint"
}

const collapsedKey = "forkyard.collapsed"

const readCollapsed = (): ReadonlyArray<string> => JSON.parse(localStorage.getItem(collapsedKey) ?? "[]")

const repoTone = (failed: number, settled: number, total: number) => {
  if (failed > 0) return "c-Failed"
  if (settled < total) return "c-Starting"
  return "c-Ready"
}

const RepoRow = ({
  project,
  worktrees,
  usage,
  open,
  onToggle
}: {
  readonly project: string
  readonly worktrees: ReadonlyArray<WorktreeView>
  readonly usage: UsageMap
  readonly open: boolean
  readonly onToggle: () => void
}) => {
  const all = worktrees.map(counts)
  const total = all.reduce((sum, item) => sum + item.total, 0)
  const settled = all.reduce((sum, item) => sum + item.settled, 0)
  const failed = all.reduce((sum, item) => sum + item.failed, 0)
  const resources = sumUsage(worktrees.map((worktree) => usageOfWorktree(usage, worktree)))
  const tone = repoTone(failed, settled, total)

  return (
    <tr className="clickable repo-row" onClick={onToggle}>
      <td colSpan={2}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="repo-name" style={{ color: keyColor(project) }}>
          {project}
        </span>
        <span className="dim">
          {" "}
          {worktrees.length} {worktrees.length === 1 ? "branch" : "branches"}
        </span>
      </td>
      <td className={`health ${tone}`}>
        {settled}/{total}
        {failed > 0 ? ` · ${failed} failed` : ""}
      </td>
      <td />
      <td className="num">{formatCpu(resources)}</td>
      <td className="num">{formatMem(resources)}</td>
      <td colSpan={2} />
    </tr>
  )
}

const DaemonLog = () => {
  const result = useAtomValue(daemonLogAtom)
  const lines = AsyncResult.isSuccess(result) ? result.value : []
  return (
    <pre className="logview">
      {lines.slice(-200).map((line, index) => (
        <div key={index}>
          <span className={levelTone(line.level)}>{line.level.padEnd(6)}</span>
          <span className="dim">{line.message}</span>
        </div>
      ))}
    </pre>
  )
}

export const Home = ({ snapshot, usage }: { readonly snapshot: Snapshot; readonly usage: UsageMap }) => {
  const worktrees = Object.values(snapshot).sort(worktreeOrder)
  const shared = sharedInfra(worktrees)
  const [collapsed, setCollapsed] = useState<ReadonlyArray<string>>(readCollapsed)
  const [expanded, setExpanded] = useState<ReadonlyArray<string>>([])
  const expand = (id: string) => setExpanded((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  const projects = [...new Set(worktrees.map((worktree) => worktree.project))]
  const toggle = (project: string) => {
    const next = collapsed.includes(project) ? collapsed.filter((item) => item !== project) : [...collapsed, project]
    localStorage.setItem(collapsedKey, JSON.stringify(next))
    setCollapsed(next)
  }

  return (
    <div className="page">
      <div className="home">
        <div className="panel home-table">
          <h2>Worktrees</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>Repo</th>
                  <th>Branch</th>
                  <th>Services</th>
                  <th>Infra</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>Open at</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const members = worktrees.filter((worktree) => worktree.project === project)
                  const open = !collapsed.includes(project)
                  return [
                    <RepoRow
                      key={project}
                      project={project}
                      worktrees={members}
                      usage={usage}
                      open={open}
                      onToggle={() => toggle(project)}
                    />,
                    ...(open
                      ? members.flatMap((worktree) => [
                          <WorktreeRow
                            key={worktree.id}
                            worktree={worktree}
                            usage={usage}
                            expanded={expanded.includes(worktree.id)}
                            onExpand={() => expand(worktree.id)}
                          />,
                          ...(expanded.includes(worktree.id)
                            ? [<ProcessRows key={`${worktree.id}-processes`} worktree={worktree} usage={usage} />]
                            : [])
                        ])
                      : [])
                  ]
                })}
              </tbody>
            </table>
            {worktrees.length === 0 ? <p className="empty">Nothing running. Run forkyard up in a checkout.</p> : null}
          </div>
        </div>
        <div className="home-side">
          <div className="panel">
            <h2>Shared infra</h2>
            <div className="scroll">
              {shared.map((item) => (
                <div className="infra-row" key={item.key}>
                  <span className={`c-${item.view._tag}`}>●</span>
                  <span className="name">
                    {"url" in item.view && item.view.url ? (
                      <a href={item.view.url} target="_blank" rel="noreferrer">
                        {item.name}
                      </a>
                    ) : (
                      item.name
                    )}
                  </span>
                  <span className="dim">used by {item.users}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="panel">
            <h2>forkyard log</h2>
            <DaemonLog />
          </div>
        </div>
      </div>
    </div>
  )
}
