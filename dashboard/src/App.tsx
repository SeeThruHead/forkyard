import { useAtomValue } from "@effect/atom-react"
import { type ReactNode, useState } from "react"
import type { Snapshot, WorktreeStatus } from "../../src/Model.ts"
import { mapleLink, mapleUrl, snapshotAtom } from "./forkyard.ts"
import { Tour } from "./Tour.tsx"
import { Branch, branchOrder, byProject, Chip, EnvTable, Frames, go, Logs, RestartButton, servicesOf, show, useRoute } from "./ui.tsx"

const Overview = ({ snapshot }: { readonly snapshot: Snapshot }) => {
  const projects = byProject(snapshot)
  const total = Object.keys(snapshot).length
  return (
    <>
      <h1>Worktrees</h1>
      <p className="meta">
        {total} worktrees from {projects.length} repos, all run by one daemon. Pick a branch for its services, logs and env, or compare one service across branches.
      </p>
      {projects.length === 0 ? <p className="empty">Nothing running. Run forkyard up in a repo.</p> : null}
      {projects.map(([project, worktrees]) => {
        const http = [...new Set(worktrees.flatMap((worktree) => servicesOf(worktree, false).filter(([, service]) => service.url).map(([name]) => name)))]
        return (
          <section key={project}>
            <h2>{project}</h2>
            <table>
              <thead>
                <tr><th style={{ width: "22%" }}>Branch</th><th>Services</th><th style={{ width: "28%" }}>Infrastructure</th></tr>
              </thead>
              <tbody>
                {worktrees.map((worktree) => (
                  <tr key={worktree.id}>
                    <td>
                      <a href={`#/wt/${worktree.id}`}><Branch name={worktree.branch} /></a>
                      <div className="sub">{worktree.root.split("/").slice(-3).join("/")}</div>
                    </td>
                    <td><div className="chips">{servicesOf(worktree, false).map(([name, service]) => <Chip key={name} name={name} service={service} />)}</div></td>
                    <td><div className="chips">{servicesOf(worktree, true).map(([name, service]) => <Chip key={name} name={service.shared ? `${name} (shared)` : name} service={service} />)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="sub">
              Compare across branches:{" "}
              {http.map((name, index) => (
                <span key={name}>{index > 0 ? ", " : ""}<a href={`#/compare/${project}/${name}`}>{name}</a></span>
              ))}
            </p>
          </section>
        )
      })}
    </>
  )
}

const ServicePane = ({ worktree, name, tab }: { readonly worktree: WorktreeStatus; readonly name: string; readonly tab: string }) => {
  const service = worktree.services[name]
  const [runId, setRunId] = useState<number | undefined>(undefined)
  if (!service) return <p className="empty">Pick a service.</p>
  const restartable = service.kind === "http" || service.kind === "worker"
  const tabs: ReadonlyArray<readonly [string, string]> = service.kind === "infra" ? [["logs", "Logs"]] : [["logs", "Logs"], ["env", "Env"]]
  return (
    <>
      <h2 style={{ marginTop: 0 }}>
        {name} {service.url ? <a href={service.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 400 }}>{service.url}</a> : null}
      </h2>
      <p className="meta">
        {service.state}
        {service.run ? `, run #${service.run}` : ""}
        {service.pid ? `, pid ${service.pid}` : ""}
        {service.detail ? `, ${service.detail}` : ""} {restartable ? <RestartButton id={worktree.id} service={name} /> : null}{" "}
        {service.kind === "infra" ? null : (
          <>
            <a href={mapleLink("logs", { service: name })} target="_blank" rel="noreferrer">logs in Maple</a>
            {" · "}
            <a href={mapleLink("traces", { service: name, ns: worktree.id })} target="_blank" rel="noreferrer">traces in Maple</a>
          </>
        )}
      </p>
      <div className="tabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={tab === key ? "on" : ""} onClick={() => go(`wt/${worktree.id}/${name}/${key}`)}>{label}</button>
        ))}
      </div>
      {tab === "env"
        ? <EnvTable id={worktree.id} service={name} run={service.run} />
        : <Logs key={`${name}-${service.run}`} worktree={worktree} name={name} service={service} runId={runId} onPick={setRunId} />}
    </>
  )
}

const WorktreeView = ({ worktree, service, tab }: { readonly worktree: WorktreeStatus; readonly service: string | undefined; readonly tab: string }) => {
  const entries = [...servicesOf(worktree, true), ...servicesOf(worktree, false)]
  const selected = service ?? entries.find(([, status]) => status.kind === "http")?.[0] ?? entries[0]?.[0] ?? ""
  return (
    <>
      <h1>{worktree.project} <Branch name={worktree.branch} /></h1>
      <p className="meta">
        <code>{worktree.root}</code>{" · "}
        <a href={mapleLink("traces", { ns: worktree.id })} target="_blank" rel="noreferrer">this worktree's traces</a>{" · "}
        <a href={mapleLink("traces", { service: "forkyard", q: worktree.id })} target="_blank" rel="noreferrer">what forkyard did for it</a>
      </p>
      <div className="layout">
        <div className="list">
          {entries.map(([name, status]) => (
            <button key={name} className={`row s-${status.state} ${name === selected ? "on" : ""}`} onClick={() => go(`wt/${worktree.id}/${name}/${tab}`)}>
              <span><span className="dot" style={{ display: "inline-block", marginRight: 7 }} />{name}</span>
              <span className="sub">{status.kind === "infra" ? (status.shared ? "shared infra" : "infra") : status.kind}{status.run ? ` #${status.run}` : ""}</span>
            </button>
          ))}
        </div>
        <div><ServicePane key={selected} worktree={worktree} name={selected} tab={tab} /></div>
      </div>
    </>
  )
}

const Compare = ({ snapshot, project, service }: { readonly snapshot: Snapshot; readonly project: string; readonly service: string }) => {
  const worktrees = Object.values(snapshot).filter((worktree) => worktree.project === project).sort(branchOrder)
  return (
    <>
      <h1>{service} on every {project} branch</h1>
      <p className="meta">Each frame is a different process tree with its own database, reached by name through the proxy. They are live, so you can click around in them.</p>
      <Frames worktrees={worktrees} service={service} />
    </>
  )
}

const Page = ({ snapshot }: { readonly snapshot: Snapshot }): ReactNode => {
  const [view, ...rest] = useRoute()
  if (view === "tour") return <Tour snapshot={snapshot} step={Number(rest[0] ?? 1)} />
  if (view === "compare") return <Compare snapshot={snapshot} project={rest[0] ?? ""} service={rest[1] ?? ""} />
  if (view !== "wt") return <Overview snapshot={snapshot} />
  const worktree = snapshot[rest[0] ?? ""]
  if (!worktree) return <p className="empty">{rest[0]} is not running.</p>
  return <WorktreeView worktree={worktree} service={rest[1]} tab={rest[2] ?? "logs"} />
}

export const App = () => {
  const snapshot = useAtomValue(snapshotAtom)
  const [view] = useRoute()
  return (
    <>
      <nav className="top">
        <b>forkyard</b>
        <a href="#/" className={view === "tour" ? "" : "on"}>Worktrees</a>
        <a href="#/tour/1" className={view === "tour" ? "on" : ""}>Tour</a>
        <a href={mapleUrl} target="_blank" rel="noreferrer">Maple</a>
      </nav>
      <main>{show(snapshot, (value) => <Page snapshot={value} />)}</main>
    </>
  )
}
