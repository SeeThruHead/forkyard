import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { ReactNode } from "react"
import { WorktreeId } from "../../src/Ids.ts"
import type { Snapshot, UsageMap } from "../../src/Model.ts"
import { snapshotAtom, usageAtom } from "./forkyard.ts"
import { formatCpu, formatMem, pidsOf, sumUsage, worktreeOrder } from "./format.ts"
import { Home } from "./Home.tsx"
import { Tour } from "./Tour.tsx"
import { branchOrder, Frames, show, useRoute } from "./ui.tsx"
import { WorktreePage } from "./Worktree.tsx"

const Totals = ({ snapshot, usage }: { readonly snapshot: Snapshot; readonly usage: UsageMap }) => {
  const worktrees = Object.values(snapshot)
  const processes = worktrees.reduce((sum, worktree) => sum + Object.keys(worktree.services).length, 0)
  const total = sumUsage(worktrees.flatMap(pidsOf).map((pid) => usage[String(pid)]))
  return (
    <>
      <span className="totals">
        {worktrees.length} worktrees · {new Set(worktrees.map((worktree) => worktree.project)).size} repos · {processes} processes
      </span>
      <span className="usage">
        CPU {formatCpu(total)} · memory {formatMem(total)}
      </span>
    </>
  )
}

const Compare = ({ snapshot, project, service }: { readonly snapshot: Snapshot; readonly project: string; readonly service: string }) => (
  <main>
    <h1>
      {service} on every {project} branch
    </h1>
    <Frames
      worktrees={Object.values(snapshot)
        .filter((worktree) => worktree.project === project)
        .sort(branchOrder)}
      service={service}
    />
  </main>
)

const Page = ({ snapshot, usage }: { readonly snapshot: Snapshot; readonly usage: UsageMap }): ReactNode => {
  const [view, ...rest] = useRoute()
  const id = WorktreeId.makeOption(rest[0] ?? "")
  const worktree = id._tag === "Some" ? snapshot[id.value] : undefined
  const ids = Object.values(snapshot)
    .filter((other) => other.project === worktree?.project)
    .sort(worktreeOrder)
    .map((other) => other.id)

  if (view === "tour") return <Tour snapshot={snapshot} step={Number(rest[0] ?? 1)} />
  if (view === "compare") return <Compare snapshot={snapshot} project={rest[0] ?? ""} service={rest[1] ?? ""} />
  if (view !== "wt") {
    document.title = "forkyard"
    return <Home snapshot={snapshot} usage={usage} />
  }
  if (!worktree) return <p className="empty">{rest[0]} is not running.</p>
  return <WorktreePage worktree={worktree} ids={ids} usage={usage} selected={rest[1] ?? "all"} showEnv={rest[2] === "env"} />
}

export const App = () => {
  const snapshot = useAtomValue(snapshotAtom)
  const usageResult = useAtomValue(usageAtom)
  const usage: UsageMap = AsyncResult.isSuccess(usageResult) ? usageResult.value : {}
  const [view] = useRoute()

  return (
    <div className="app">
      <div className="topbar">
        <a className="name" href="#/">
          forkyard
        </a>
        {AsyncResult.isSuccess(snapshot) ? <Totals snapshot={snapshot.value} usage={usage} /> : null}
        <nav>
          <a href="#/" className={view === "tour" ? "" : "on"}>
            Worktrees
          </a>
          <a href="#/tour/1" className={view === "tour" ? "on" : ""}>
            Tour
          </a>
        </nav>
      </div>
      {show(snapshot, (value) => (
        <Page snapshot={value} usage={usage} />
      ))}
    </div>
  )
}
