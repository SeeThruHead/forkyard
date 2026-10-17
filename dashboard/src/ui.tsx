import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react"
import type { ServiceStatus, Snapshot, WorktreeStatus } from "../../src/Model.ts"
import { envAtom, restartAtom, runLogAtom, runsAtom } from "./forkyard.ts"

const subscribeHash = (notify: () => void) => {
  window.addEventListener("hashchange", notify)
  return () => window.removeEventListener("hashchange", notify)
}

export const useRoute = () => useSyncExternalStore(subscribeHash, () => location.hash.replace(/^#\/?/, "")).split("/").filter(Boolean)

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
  <span className="branch" style={{ background: `hsl(${hue(name)} 55% 34%)` }}>{name}</span>
)

export const isInfra = (service: ServiceStatus) => service.kind === "infra"

export const servicesOf = (worktree: WorktreeStatus, infra: boolean) =>
  Object.entries(worktree.services).filter(([, service]) => isInfra(service) === infra)

export const Chip = ({ name, service }: { readonly name: string; readonly service: ServiceStatus }) => {
  const inner = (
    <>
      <span className="dot" />
      {name}
    </>
  )
  return service.url
    ? <a className={`chip s-${service.state}`} href={service.url} target="_blank" rel="noreferrer" title={`${service.state} ${service.url}`}>{inner}</a>
    : <span className={`chip s-${service.state}`} title={service.detail ?? service.state}>{inner}</span>
}

export const branchOrder = (a: WorktreeStatus, b: WorktreeStatus) => {
  if (a.branch === "main") return -1
  if (b.branch === "main") return 1
  return a.branch.localeCompare(b.branch)
}

export const byProject = (snapshot: Snapshot) =>
  Object.entries(
    Object.values(snapshot).reduce<Readonly<Record<string, ReadonlyArray<WorktreeStatus>>>>(
      (all, worktree) => ({ ...all, [worktree.project]: [...(all[worktree.project] ?? []), worktree].sort(branchOrder) }),
      {}
    )
  ).sort(([a], [b]) => a.localeCompare(b))

const logOwner = (worktree: WorktreeStatus, name: string, service: ServiceStatus) => {
  if (!isInfra(service)) return { id: worktree.id, service: name }
  const instance = service.shared ? "shared" : worktree.id
  return { id: `infra:${instance}`, service: name }
}

const time = (at: number) => new Date(at).toLocaleTimeString()

const runLabel = (run: { readonly n: number; readonly endedAt: number | null; readonly exitCode: number | null; readonly startedAt: number }) => {
  if (run.endedAt === null) return `run #${run.n}, running since ${time(run.startedAt)}`
  if (run.exitCode === null) return `run #${run.n}, stopped at ${time(run.endedAt)}`
  return `run #${run.n}, exited ${run.exitCode} at ${time(run.endedAt)}`
}

const LogLines = ({ runId }: { readonly runId: number }) => {
  const result = useAtomValue(runLogAtom(runId))
  const box = useRef<HTMLPreElement>(null)
  const count = AsyncResult.isSuccess(result) ? result.value.length : 0
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [count])
  return (
    <pre className="log" ref={box}>
      {AsyncResult.isSuccess(result) && result.value.length === 0 ? "No output yet." : ""}
      {AsyncResult.isSuccess(result) ? result.value.map((line) => `${line.line}\n`).join("") : ""}
    </pre>
  )
}

export const Logs = ({ worktree, name, service, runId, onPick }: {
  readonly worktree: WorktreeStatus
  readonly name: string
  readonly service: ServiceStatus
  readonly runId: number | undefined
  readonly onPick: (runId: number) => void
}) => {
  const owner = logOwner(worktree, name, service)
  const runs = useAtomValue(runsAtom(`${owner.id}|${owner.service}|${service.run ?? 0}|${service.state}`))
  return show(runs, (list) => {
    const chosen = runId ?? list[0]?.id
    if (chosen === undefined) return <p className="empty">No runs yet.</p>
    return (
      <>
        <p>
          <select value={chosen} onChange={(event) => onPick(Number(event.target.value))}>
            {list.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
          </select>{" "}
          <span className="sub">{list.length} runs kept. Older runs stay readable after a restart.</span>
        </p>
        <LogLines runId={chosen} />
      </>
    )
  })
}

export const EnvTable = ({ id, service, run }: { readonly id: string; readonly service: string; readonly run: number | undefined }) => {
  const env = useAtomValue(envAtom(`${id}|${service}|${run ?? 0}`))
  return show(env, (vars) => (
    <table>
      <thead>
        <tr><th>Variable</th><th>Value the process got</th><th>Came from</th><th>Before forkyard</th></tr>
      </thead>
      <tbody>
        {vars.map((entry) => (
          <tr key={entry.key}>
            <td><code>{entry.key}</code></td>
            <td><code>{entry.value}</code>{entry.warning ? <div className="warn">{entry.warning}</div> : null}</td>
            <td>{entry.source}</td>
            <td>{entry.replaced ? <code className="was">{entry.replaced}</code> : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ))
}

export const RestartButton = ({ id, service }: { readonly id: string; readonly service: string }) => {
  const restart = useAtomSet(restartAtom)
  return <button className="btn light" onClick={() => restart({ id, service })}>Restart {service}</button>
}

export const Frames = ({ worktrees, service, path = "" }: { readonly worktrees: ReadonlyArray<WorktreeStatus>; readonly service: string; readonly path?: string }) => {
  const targets = worktrees.flatMap((worktree) => {
    const status = worktree.services[service]
    return status?.url ? [{ worktree, url: `${status.url}${path}` }] : []
  })
  if (targets.length === 0) return <p className="empty">No running {service} to compare.</p>
  return (
    <div className="frames" style={{ gridTemplateColumns: `repeat(${Math.min(targets.length, 3)}, minmax(0, 1fr))` }}>
      {targets.map(({ worktree, url }) => (
        <div className="frame" key={worktree.id}>
          <header>
            <span><Branch name={worktree.branch} /> {service}</span>
            <a href={url} target="_blank" rel="noreferrer">{url.replace("http://", "")}</a>
          </header>
          <iframe src={url} title={`${service} on ${worktree.branch}`} />
        </div>
      ))}
    </div>
  )
}
