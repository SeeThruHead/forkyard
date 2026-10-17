import { useAtomValue } from "@effect/atom-react"
import { type ReactNode, useState } from "react"
import { ownerOfInfra, ownerOfWorktree, type RunId, ServiceName, WorktreeId } from "../../src/Ids.ts"
import {
  type InfraView,
  runOf,
  serviceUrl,
  type ServiceView,
  type Snapshot,
  stateDetail,
  stateLabel,
  type WorktreeView
} from "../../src/Model.ts"
import { mapleLink, mapleUrl, snapshotAtom } from "./forkyard.ts"
import { Tour } from "./Tour.tsx"
import {
  Branch,
  branchOrder,
  byProject,
  EnvTable,
  Frames,
  go,
  InfraChips,
  infraLabel,
  Logs,
  RestartButton,
  ServiceChips,
  show,
  useRoute
} from "./ui.tsx"

const httpServices = (worktrees: ReadonlyArray<WorktreeView>) => [
  ...new Set(
    worktrees.flatMap((worktree) =>
      Object.entries(worktree.services)
        .filter(([, view]) => view._tag === "Http")
        .map(([name]) => name)
    )
  )
]

const ProjectSection = ({ project, worktrees }: { readonly project: string; readonly worktrees: ReadonlyArray<WorktreeView> }) => (
  <section>
    <h2>{project}</h2>
    <table>
      <thead>
        <tr>
          <th style={{ width: "22%" }}>Branch</th>
          <th>Services</th>
          <th style={{ width: "28%" }}>Infrastructure</th>
        </tr>
      </thead>
      <tbody>
        {worktrees.map((worktree) => (
          <tr key={worktree.id}>
            <td>
              <a href={`#/wt/${worktree.id}`}>
                <Branch name={worktree.branch} />
              </a>
              <div className="sub">{worktree.root.split("/").slice(-3).join("/")}</div>
            </td>
            <td>
              <ServiceChips worktree={worktree} />
            </td>
            <td>
              <InfraChips worktree={worktree} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    <p className="sub">
      Compare across branches:{" "}
      {httpServices(worktrees).map((name, index) => (
        <span key={name}>
          {index > 0 ? ", " : ""}
          <a href={`#/compare/${project}/${name}`}>{name}</a>
        </span>
      ))}
    </p>
  </section>
)

const Overview = ({ snapshot }: { readonly snapshot: Snapshot }) => {
  const projects = byProject(snapshot)

  return (
    <>
      <h1>Worktrees</h1>
      <p className="meta">
        {Object.keys(snapshot).length} worktrees from {projects.length} repos, all run by one daemon. Pick a branch for its services, logs
        and env, or compare one service across branches.
      </p>
      {projects.length === 0 ? <p className="empty">Nothing running. Run forkyard up in a repo.</p> : null}
      {projects.map(([project, worktrees]) => (
        <ProjectSection key={project} project={project} worktrees={worktrees} />
      ))}
    </>
  )
}

const MapleLinks = ({ worktree, name }: { readonly worktree: WorktreeView; readonly name: string }) => (
  <>
    <a href={mapleLink("logs", { service: name })} target="_blank" rel="noreferrer">
      logs in Maple
    </a>
    {" · "}
    <a href={mapleLink("traces", { service: name, ns: worktree.id })} target="_blank" rel="noreferrer">
      traces in Maple
    </a>
  </>
)

const Tabs = ({ worktree, name, tab }: { readonly worktree: WorktreeView; readonly name: string; readonly tab: string }) => (
  <div className="tabs">
    {[
      ["logs", "Logs"],
      ["env", "Env"]
    ].map(([key, label]) => (
      <button key={key} className={tab === key ? "on" : ""} onClick={() => go(`wt/${worktree.id}/${name}/${key}`)}>
        {label}
      </button>
    ))}
  </div>
)

const ServicePane = ({
  worktree,
  name,
  view,
  tab
}: {
  readonly worktree: WorktreeView
  readonly name: ServiceName
  readonly view: ServiceView
  readonly tab: string
}) => {
  const [runId, setRunId] = useState<RunId | undefined>(undefined)
  const run = runOf(view.state)
  const url = serviceUrl(view)
  const detail = stateDetail(view.state)
  const version = `${run?.run ?? 0}-${view.state._tag}`

  return (
    <>
      <h2 style={{ marginTop: 0 }}>
        {name}{" "}
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 400 }}>
            {url}
          </a>
        ) : null}
      </h2>
      <p className="meta">
        {stateLabel(view.state)}
        {run ? `, run #${run.run}, pid ${run.pid}` : ""}
        {detail ? `, ${detail}` : ""} {view._tag === "Task" ? null : <RestartButton id={worktree.id} service={name} />}{" "}
        <MapleLinks worktree={worktree} name={name} />
      </p>
      <Tabs worktree={worktree} name={name} tab={tab} />
      {tab === "env" ? (
        <EnvTable id={worktree.id} service={name} version={version} />
      ) : (
        <Logs key={version} owner={ownerOfWorktree(worktree.id)} service={name} version={version} runId={runId} onPick={setRunId} />
      )}
    </>
  )
}

const InfraPane = ({ name, view }: { readonly name: string; readonly view: InfraView }) => {
  const [runId, setRunId] = useState<RunId | undefined>(undefined)

  return (
    <>
      <h2 style={{ marginTop: 0 }}>{name}</h2>
      <p className="meta">
        {infraLabel(view)}, {view.scope === "shared" ? "shared by every worktree" : "this worktree only"}
        {view._tag === "InfraFailed" ? `, ${view.reason}` : ""}
      </p>
      {view._tag === "InfraReady" ? (
        <Logs owner={ownerOfInfra(view.instance)} service={name} version={view.instance} runId={runId} onPick={setRunId} />
      ) : (
        <p className="empty">No process yet.</p>
      )}
    </>
  )
}

const ListRow = ({
  worktree,
  entry,
  label,
  detail,
  selected,
  tab
}: {
  readonly worktree: WorktreeView
  readonly entry: string
  readonly label: string
  readonly detail: string
  readonly selected: boolean
  readonly tab: string
}) => (
  <button className={`row s-${label} ${selected ? "on" : ""}`} onClick={() => go(`wt/${worktree.id}/${entry}/${tab}`)}>
    <span>
      <span className="dot" style={{ display: "inline-block", marginRight: 7 }} />
      {entry.replace(/^infra:/, "")}
    </span>
    <span className="sub">{detail}</span>
  </button>
)

const Pane = ({ worktree, selected, tab }: { readonly worktree: WorktreeView; readonly selected: string; readonly tab: string }) => {
  const infraName = selected.startsWith("infra:") ? selected.slice("infra:".length) : undefined
  const infra = infraName ? Object.entries(worktree.infra).find(([name]) => name === infraName)?.[1] : undefined
  const service = Object.entries(worktree.services).find(([name]) => name === selected)?.[1]

  if (infraName && infra) return <InfraPane name={infraName} view={infra} />
  if (service) return <ServicePane worktree={worktree} name={ServiceName.make(selected)} view={service} tab={tab} />
  return <p className="empty">Pick a service.</p>
}

const WorktreePage = ({
  worktree,
  selected,
  tab
}: {
  readonly worktree: WorktreeView
  readonly selected: string | undefined
  readonly tab: string
}) => {
  const services = Object.entries(worktree.services)
  const chosen = selected ?? services.find(([, view]) => view._tag === "Http")?.[0] ?? services[0]?.[0] ?? ""

  return (
    <>
      <h1>
        {worktree.project} <Branch name={worktree.branch} />
      </h1>
      <p className="meta">
        <code>{worktree.root}</code>
        {" · "}
        <a href={mapleLink("traces", { ns: worktree.id })} target="_blank" rel="noreferrer">
          this worktree's traces
        </a>
        {" · "}
        <a href={mapleLink("traces", { service: "forkyard", q: worktree.id })} target="_blank" rel="noreferrer">
          what forkyard did for it
        </a>
      </p>
      <div className="layout">
        <div className="list">
          {Object.entries(worktree.infra).map(([name, view]) => (
            <ListRow
              key={name}
              worktree={worktree}
              entry={`infra:${name}`}
              label={infraLabel(view)}
              detail={view.scope === "shared" ? "shared infra" : "infra"}
              selected={chosen === `infra:${name}`}
              tab={tab}
            />
          ))}
          {services.map(([name, view]) => (
            <ListRow
              key={name}
              worktree={worktree}
              entry={name}
              label={stateLabel(view.state)}
              detail={`${view._tag.toLowerCase()}${runOf(view.state) ? ` #${runOf(view.state)?.run}` : ""}`}
              selected={chosen === name}
              tab={tab}
            />
          ))}
        </div>
        <div>
          <Pane key={chosen} worktree={worktree} selected={chosen} tab={tab} />
        </div>
      </div>
    </>
  )
}

const Compare = ({ snapshot, project, service }: { readonly snapshot: Snapshot; readonly project: string; readonly service: string }) => {
  const worktrees = Object.values(snapshot)
    .filter((worktree) => worktree.project === project)
    .sort(branchOrder)

  return (
    <>
      <h1>
        {service} on every {project} branch
      </h1>
      <p className="meta">
        Each frame is a different process tree with its own database, reached by name through the proxy. They are live, so you can click
        around in them.
      </p>
      <Frames worktrees={worktrees} service={service} />
    </>
  )
}

const worktreeAt = (snapshot: Snapshot, id: string | undefined) => {
  const match = WorktreeId.makeOption(id ?? "")
  return match._tag === "Some" ? snapshot[match.value] : undefined
}

const Page = ({ snapshot }: { readonly snapshot: Snapshot }): ReactNode => {
  const [view, ...rest] = useRoute()
  const worktree = worktreeAt(snapshot, rest[0])

  if (view === "tour") return <Tour snapshot={snapshot} step={Number(rest[0] ?? 1)} />
  if (view === "compare") return <Compare snapshot={snapshot} project={rest[0] ?? ""} service={rest[1] ?? ""} />
  if (view !== "wt") return <Overview snapshot={snapshot} />
  if (!worktree) return <p className="empty">{rest[0]} is not running.</p>
  return <WorktreePage worktree={worktree} selected={rest[1]} tab={rest[2] ?? "logs"} />
}

export const App = () => {
  const snapshot = useAtomValue(snapshotAtom)
  const [view] = useRoute()

  return (
    <>
      <nav className="top">
        <b>forkyard</b>
        <a href="#/" className={view === "tour" ? "" : "on"}>
          Worktrees
        </a>
        <a href="#/tour/1" className={view === "tour" ? "on" : ""}>
          Tour
        </a>
        <a href={mapleUrl} target="_blank" rel="noreferrer">
          Maple
        </a>
      </nav>
      <main>
        {show(snapshot, (value) => (
          <Page snapshot={value} />
        ))}
      </main>
    </>
  )
}
