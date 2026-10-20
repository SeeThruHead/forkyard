import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { ServiceName } from "../../src/Ids.ts"
import {
  distinctPids,
  formatCpu,
  formatMem,
  ownPidsOf,
  runOf,
  serviceUrl,
  sharedCountOf,
  sharedLabel,
  type Snapshot,
  type UsageMap,
  usageOfPids,
  type WorktreeView
} from "../../src/Model.ts"
import { daemonLogAtom, restartAtom, stopAtom } from "./forkyard.ts"
import { counts, healthOf, keyColor, mainUrl, worktreeOrder } from "./format.ts"
import { go } from "./ui.tsx"

const collapsedKey = "forkyard.collapsed"

const readCollapsed = (): ReadonlyArray<string> => JSON.parse(localStorage.getItem(collapsedKey) ?? "[]")

const toggled = (list: ReadonlyArray<string>, item: string) =>
  list.includes(item) ? list.filter((other) => other !== item) : [...list, item]

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

const repoTone = (failed: number, settled: number, total: number) => {
  if (failed > 0) return "c-Failed"
  if (settled < total) return "c-Starting"
  return "c-Ready"
}

const levelTone = (level: string) => {
  if (level === "Warn") return "c-Starting"
  if (level === "Error") return "c-Failed"
  return "faint"
}

const Processes = ({ worktree, usage }: { readonly worktree: WorktreeView; readonly usage: UsageMap }) => {
  const restart = useAtomSet(restartAtom)
  return (
    <div className="procs">
      {Object.entries(worktree.services).map(([name, view]) => {
        const run = runOf(view.state)
        const use = run ? usage[String(run.pid)] : undefined
        const url = serviceUrl(view)
        const shared = sharedLabel(view)
        const tone = shared ? "shared" : `c-${view.state._tag}`
        return (
          <div className="proc" key={name}>
            <span className={tone}>●</span>
            <span className={shared ? "shared" : ""}>{name}</span>
            <span className={tone}>{view.state._tag.toLowerCase()}</span>
            <span className="stat dim">{run ? `#${run.run}` : ""}</span>
            <span className={shared ? "stat shared" : "stat"}>{formatCpu(use)}</span>
            <span className={shared ? "stat shared" : "stat"}>{formatMem(use)}</span>
            <span className="proc-note">
              {shared ? <span className="shared">{shared} </span> : null}
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  {url.replace("http://", "")}
                </a>
              ) : (
                <span className="c-Failed">{"reason" in view.state ? view.state.reason : ""}</span>
              )}
            </span>
            {view._tag === "Task" ? (
              <span />
            ) : (
              <button
                className="button small"
                title={`Restart ${name}`}
                onClick={() => restart({ id: worktree.id, service: ServiceName.make(name) })}
              >
                ↻
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

const Branch = ({
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
  const total = usageOfPids(usage, ownPidsOf(worktree))
  const url = mainUrl(worktree)

  return (
    <>
      <div className="branch-row" onClick={() => go(`wt/${worktree.id}`)}>
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
        <span className="branch-label">{worktree.branch}</span>
        <span className={`stat c-${health.state}`}>{health.label}</span>
        {sharedCountOf(worktree) > 0 ? <span className="stat shared">{sharedCountOf(worktree)} shared</span> : null}
        <span className={`stat ${infraReady === infra.length ? "dim" : "c-Starting"}`}>
          infra {infraReady}/{infra.length}
        </span>
        <span className="stat">{formatCpu(total)}</span>
        <span className="stat">{formatMem(total)}</span>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
            {url.replace("http://", "")}
          </a>
        ) : null}
        <span className="grow" />
        <button
          className="button danger small"
          onClick={(event) => {
            event.stopPropagation()
            stop(worktree.id)
          }}
        >
          ■ Stop
        </button>
      </div>
      {expanded ? <Processes worktree={worktree} usage={usage} /> : null}
    </>
  )
}

const Repo = ({
  project,
  worktrees,
  usage,
  open,
  onToggle,
  expanded,
  onExpand
}: {
  readonly project: string
  readonly worktrees: ReadonlyArray<WorktreeView>
  readonly usage: UsageMap
  readonly open: boolean
  readonly onToggle: () => void
  readonly expanded: ReadonlyArray<string>
  readonly onExpand: (id: string) => void
}) => {
  const all = worktrees.map(counts)
  const total = all.reduce((sum, item) => sum + item.total, 0)
  const settled = all.reduce((sum, item) => sum + item.settled, 0)
  const failed = all.reduce((sum, item) => sum + item.failed, 0)
  const resources = usageOfPids(usage, distinctPids(worktrees))

  return (
    <div className="repo">
      <div className="repo-head" onClick={onToggle}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="repo-name" style={{ color: keyColor(project) }}>
          {project}
        </span>
        <span className="dim">
          {worktrees.length} {worktrees.length === 1 ? "branch" : "branches"}
        </span>
        <span className={`stat ${repoTone(failed, settled, total)}`}>
          {settled}/{total}
          {failed > 0 ? ` · ${failed} failed` : ""}
        </span>
        <span className="stat">{formatCpu(resources)}</span>
        <span className="stat">{formatMem(resources)}</span>
      </div>
      {open
        ? worktrees.map((worktree) => (
            <Branch
              key={worktree.id}
              worktree={worktree}
              usage={usage}
              expanded={expanded.includes(worktree.id)}
              onExpand={() => onExpand(worktree.id)}
            />
          ))
        : null}
    </div>
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
  const projects = [...new Set(worktrees.map((worktree) => worktree.project))]
  const shared = sharedInfra(worktrees)
  const [collapsed, setCollapsed] = useState<ReadonlyArray<string>>(readCollapsed)
  const [expanded, setExpanded] = useState<ReadonlyArray<string>>([])

  const toggle = (project: string) => {
    const next = toggled(collapsed, project)
    localStorage.setItem(collapsedKey, JSON.stringify(next))
    setCollapsed(next)
  }

  return (
    <div className="page">
      <div className="home">
        <div className="panel home-table">
          <h2>Worktrees</h2>
          <div className="scroll tree">
            {projects.map((project) => (
              <Repo
                key={project}
                project={project}
                worktrees={worktrees.filter((worktree) => worktree.project === project)}
                usage={usage}
                open={!collapsed.includes(project)}
                onToggle={() => toggle(project)}
                expanded={expanded}
                onExpand={(id) => setExpanded((current) => toggled(current, id))}
              />
            ))}
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
