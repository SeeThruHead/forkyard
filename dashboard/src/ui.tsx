import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react"
import type { ProcessOwner, RunId, ServiceName, WorktreeId } from "../../src/Ids.ts"
import {
  type InfraView,
  type RunInfo,
  serviceUrl,
  type ServiceView,
  type Snapshot,
  stateDetail,
  stateLabel,
  type WorktreeView
} from "../../src/Model.ts"
import { envAtom, envKey, restartAtom, runLogAtom, runsAtom, runsKey } from "./forkyard.ts"

const subscribeHash = (notify: () => void) => {
  window.addEventListener("hashchange", notify)
  return () => window.removeEventListener("hashchange", notify)
}

export const useRoute = () =>
  useSyncExternalStore(subscribeHash, () => location.hash.replace(/^#\/?/, ""))
    .split("/")
    .filter(Boolean)

export const go = (path: string) => {
  location.hash = `/${path}`
}

export const show = <A, E>(result: AsyncResult.AsyncResult<A, E>, render: (value: A) => ReactNode): ReactNode =>
  AsyncResult.match(result, {
    onInitial: () => <p className="empty">Loading…</p>,
    onFailure: (failure) => <p className="warn">{String(Cause.squash(failure.cause))}</p>,
    onSuccess: (success) => render(success.value)
  })

const hue = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7)

export const Branch = ({ name }: { readonly name: string }) => (
  <span className="branch" style={{ background: `hsl(${hue(name)} 55% 34%)` }}>
    {name}
  </span>
)

export const infraLabel = (view: InfraView) => view._tag.replace("Infra", "").toLowerCase()

const ChipBody = ({ name }: { readonly name: string }) => (
  <>
    <span className="dot" />
    {name}
  </>
)

export const ServiceChip = ({ name, view }: { readonly name: string; readonly view: ServiceView }) => {
  const url = serviceUrl(view)
  const label = stateLabel(view.state)

  if (url)
    return (
      <a className={`chip s-${label}`} href={url} target="_blank" rel="noreferrer" title={`${label} ${url}`}>
        <ChipBody name={name} />
      </a>
    )
  return (
    <span className={`chip s-${label}`} title={stateDetail(view.state) ?? label}>
      <ChipBody name={name} />
    </span>
  )
}

export const InfraChip = ({ name, view }: { readonly name: string; readonly view: InfraView }) => {
  const label = infraLabel(view)
  const title = view.scope === "shared" ? `${name} (shared)` : name
  const url = view._tag === "InfraReady" ? view.url : undefined

  if (url)
    return (
      <a className={`chip s-${label}`} href={url} target="_blank" rel="noreferrer">
        <ChipBody name={title} />
      </a>
    )
  return (
    <span className={`chip s-${label}`} title={view._tag === "InfraFailed" ? view.reason : label}>
      <ChipBody name={title} />
    </span>
  )
}

export const ServiceChips = ({ worktree }: { readonly worktree: WorktreeView }) => (
  <div className="chips">
    {Object.entries(worktree.services).map(([name, view]) => (
      <ServiceChip key={name} name={name} view={view} />
    ))}
  </div>
)

export const InfraChips = ({ worktree }: { readonly worktree: WorktreeView }) => (
  <div className="chips">
    {Object.entries(worktree.infra).map(([name, view]) => (
      <InfraChip key={name} name={name} view={view} />
    ))}
  </div>
)

export const branchOrder = (a: WorktreeView, b: WorktreeView) => {
  if (a.branch === "main") return -1
  if (b.branch === "main") return 1
  return a.branch.localeCompare(b.branch)
}

export const byProject = (snapshot: Snapshot) =>
  Object.entries(
    Object.values(snapshot).reduce<Readonly<Record<string, ReadonlyArray<WorktreeView>>>>(
      (all, worktree) => ({ ...all, [worktree.project]: [...(all[worktree.project] ?? []), worktree].sort(branchOrder) }),
      {}
    )
  ).sort(([a], [b]) => a.localeCompare(b))

const time = (at: number) => new Date(at).toLocaleTimeString()

const runLabel = (run: RunInfo) => {
  if (run._tag === "Running") return `run #${run.n}, running since ${time(run.startedAt)}`
  if (run._tag === "Stopped") return `run #${run.n}, stopped at ${time(run.endedAt)}`
  return `run #${run.n}, exited ${run.exitCode} at ${time(run.endedAt)}`
}

const LogLines = ({ runId }: { readonly runId: RunId }) => {
  const result = useAtomValue(runLogAtom(runId))
  const box = useRef<HTMLPreElement>(null)
  const lines = AsyncResult.isSuccess(result) ? result.value : []

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [lines.length])

  return (
    <pre className="log" ref={box}>
      {lines.length === 0 ? "No output yet." : lines.map((line) => `${line.line}\n`).join("")}
    </pre>
  )
}

export const Logs = ({
  owner,
  service,
  version,
  runId,
  onPick
}: {
  readonly owner: ProcessOwner
  readonly service: string
  readonly version: string
  readonly runId: RunId | undefined
  readonly onPick: (runId: RunId) => void
}) => {
  const runs = useAtomValue(runsAtom(runsKey(owner, service, version)))

  return show(runs, (list) => {
    const chosen = list.find((run) => run.id === runId)?.id ?? list[0]?.id
    if (chosen === undefined) return <p className="empty">No runs yet.</p>

    return (
      <>
        <p>
          <select value={chosen} onChange={(event) => onPick(list.find((run) => String(run.id) === event.target.value)?.id ?? chosen)}>
            {list.map((run) => (
              <option key={run.id} value={run.id}>
                {runLabel(run)}
              </option>
            ))}
          </select>{" "}
          <span className="sub">{list.length} runs kept. Older runs stay readable after a restart.</span>
        </p>
        <LogLines runId={chosen} />
      </>
    )
  })
}

export const EnvTable = ({
  id,
  service,
  version
}: {
  readonly id: WorktreeId
  readonly service: ServiceName
  readonly version: string
}) => {
  const env = useAtomValue(envAtom(envKey(id, service, version)))

  return show(env, (vars) => (
    <table>
      <thead>
        <tr>
          <th>Variable</th>
          <th>Value the process got</th>
          <th>Came from</th>
          <th>Before forkyard</th>
        </tr>
      </thead>
      <tbody>
        {vars.map((entry) => (
          <tr key={entry.key}>
            <td>
              <code>{entry.key}</code>
            </td>
            <td>
              <code>{entry.value}</code>
              {entry.warning ? <div className="warn">{entry.warning}</div> : null}
            </td>
            <td>{entry.source}</td>
            <td>{entry.replaced ? <code className="was">{entry.replaced}</code> : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ))
}

export const RestartButton = ({ id, service }: { readonly id: WorktreeId; readonly service: ServiceName }) => {
  const restart = useAtomSet(restartAtom)
  return (
    <button className="btn light" onClick={() => restart({ id, service })}>
      Restart {service}
    </button>
  )
}

export const Frames = ({ worktrees, service }: { readonly worktrees: ReadonlyArray<WorktreeView>; readonly service: string }) => {
  const targets = worktrees.flatMap((worktree) => {
    const view = Object.entries(worktree.services).find(([name]) => name === service)?.[1]
    const url = view ? serviceUrl(view) : undefined
    return url ? [{ worktree, url }] : []
  })

  if (targets.length === 0) return <p className="empty">No running {service} to compare.</p>

  return (
    <div className="frames" style={{ gridTemplateColumns: `repeat(${Math.min(targets.length, 3)}, minmax(0, 1fr))` }}>
      {targets.map(({ worktree, url }) => (
        <div className="frame" key={worktree.id}>
          <header>
            <span>
              <Branch name={worktree.branch} /> {service}
            </span>
            <a href={url} target="_blank" rel="noreferrer">
              {url.replace("http://", "")}
            </a>
          </header>
          <iframe src={url} title={`${service} on ${worktree.branch}`} />
        </div>
      ))}
    </div>
  )
}
