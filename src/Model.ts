import { Schema } from "effect"
import { AbsolutePath, BranchSlug, InfraName, Pid, ProcessOwner, ProjectName, RunId, RunNumber, ServiceName, WorktreeId } from "./Ids.ts"

export const RunRef = Schema.Struct({
  runId: RunId,
  run: RunNumber,
  pid: Pid
})
export type RunRef = typeof RunRef.Type

export const ServiceState = Schema.Union([
  Schema.TaggedStruct("Waiting", {}),
  Schema.TaggedStruct("Preparing", {}),
  Schema.TaggedStruct("Starting", { run: RunRef }),
  Schema.TaggedStruct("Ready", { run: RunRef }),
  Schema.TaggedStruct("Restarting", { run: RunRef, reason: Schema.String }),
  Schema.TaggedStruct("Done", { run: RunRef }),
  Schema.TaggedStruct("Failed", { reason: Schema.String, run: Schema.optional(RunRef) })
])
export type ServiceState = typeof ServiceState.Type

const sharedWith = { sharedWith: Schema.optional(WorktreeId) }

export const ServiceView = Schema.Union([
  Schema.TaggedStruct("Http", { url: Schema.String, state: ServiceState, ...sharedWith }),
  Schema.TaggedStruct("Worker", { state: ServiceState, ...sharedWith }),
  Schema.TaggedStruct("Task", { state: ServiceState, ...sharedWith })
])
export type ServiceView = typeof ServiceView.Type

export const InfraScope = Schema.Literals(["shared", "worktree"])
export type InfraScope = typeof InfraScope.Type

export const InfraView = Schema.Union([
  Schema.TaggedStruct("InfraStarting", { scope: InfraScope }),
  Schema.TaggedStruct("InfraReady", { scope: InfraScope, instance: Schema.String, url: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("InfraFailed", { scope: InfraScope, reason: Schema.String })
])
export type InfraView = typeof InfraView.Type

export const WorktreeView = Schema.Struct({
  id: WorktreeId,
  project: ProjectName,
  branch: BranchSlug,
  root: AbsolutePath,
  profile: Schema.String,
  services: Schema.Record(ServiceName, ServiceView),
  infra: Schema.Record(InfraName, InfraView)
})
export type WorktreeView = typeof WorktreeView.Type

export const Snapshot = Schema.Record(WorktreeId, WorktreeView)
export type Snapshot = typeof Snapshot.Type

export const RunLine = Schema.Struct({
  runId: RunId,
  seq: Schema.Int,
  at: Schema.Number,
  line: Schema.String
})
export type RunLine = typeof RunLine.Type

export const LogLine = Schema.Struct({
  ...RunLine.fields,
  owner: ProcessOwner,
  service: Schema.String
})
export type LogLine = typeof LogLine.Type

const runFields = {
  id: RunId,
  owner: ProcessOwner,
  service: Schema.String,
  n: RunNumber,
  pid: Pid,
  command: Schema.String,
  startedAt: Schema.Number
}

export const RunInfo = Schema.Union([
  Schema.TaggedStruct("Running", runFields),
  Schema.TaggedStruct("Exited", { ...runFields, endedAt: Schema.Number, exitCode: Schema.Int }),
  Schema.TaggedStruct("Stopped", { ...runFields, endedAt: Schema.Number })
])
export type RunInfo = typeof RunInfo.Type

export const EnvVar = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  sensitive: Schema.Boolean,
  source: Schema.String,
  replaced: Schema.optional(Schema.String),
  warning: Schema.optional(Schema.String)
})
export type EnvVar = typeof EnvVar.Type

export const DaemonInfo = Schema.Struct({
  cli: Schema.String,
  dashboard: Schema.String,
  version: Schema.optional(Schema.String),
  protocol: Schema.optional(Schema.Int),
  pendingVersion: Schema.optional(Schema.String)
})
export type DaemonInfo = typeof DaemonInfo.Type

export const UsageMap = Schema.Record(Schema.String, Schema.Struct({ cpu: Schema.Number, rssKb: Schema.Number }))
export type UsageMap = typeof UsageMap.Type

export const DaemonLine = Schema.Struct({ at: Schema.Number, level: Schema.String, message: Schema.String })
export type DaemonLine = typeof DaemonLine.Type

export const runOf = (state: ServiceState): RunRef | undefined => ("run" in state ? state.run : undefined)

export const sharedLabel = (view: ServiceView) => (view.sharedWith ? `via ${view.sharedWith.split(".")[0]}` : undefined)

export type Usage = { readonly cpu: number; readonly rssKb: number }

export const usageFor = (usage: UsageMap, pid: number): Usage | undefined => usage[String(pid)]

export const sumUsage = (usages: ReadonlyArray<Usage | undefined>): Usage =>
  usages.reduce<Usage>((total, usage) => ({ cpu: total.cpu + (usage?.cpu ?? 0), rssKb: total.rssKb + (usage?.rssKb ?? 0) }), {
    cpu: 0,
    rssKb: 0
  })

export const formatCpu = (usage: Usage | undefined) => (usage ? `${usage.cpu.toFixed(0)}%` : "")

export const formatMem = (usage: Usage | undefined) => {
  if (!usage) return ""
  const mb = usage.rssKb / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb.toFixed(0)}M`
}

const pidsOfViews = (views: ReadonlyArray<ServiceView>) =>
  views.flatMap((view) => {
    const run = runOf(view.state)
    return run ? [run.pid] : []
  })

export const sharedCountOf = (worktree: WorktreeView) => Object.values(worktree.services).filter((view) => view.sharedWith).length

export const ownPidsOf = (worktree: WorktreeView) => pidsOfViews(Object.values(worktree.services).filter((view) => !view.sharedWith))

export const distinctPids = (worktrees: ReadonlyArray<WorktreeView>) => [
  ...new Set(pidsOfViews(worktrees.flatMap((worktree) => Object.values(worktree.services))))
]

export const usageOfPids = (usage: UsageMap, pids: ReadonlyArray<number>) => sumUsage(pids.map((pid) => usageFor(usage, pid)))

export const stateLabel = (state: ServiceState) => state._tag.toLowerCase()

export const stateDetail = (state: ServiceState) => ("reason" in state ? state.reason : undefined)

export const isSettledState = (state: ServiceState) => state._tag === "Ready" || state._tag === "Done" || state._tag === "Failed"

export const serviceUrl = (view: ServiceView) => (view._tag === "Http" ? view.url : undefined)

export const isSettled = (worktree: WorktreeView | undefined) => {
  if (!worktree) return false

  const services = Object.values(worktree.services)
  if (services.length === 0) return false

  return services.every((view) => isSettledState(view.state))
}
