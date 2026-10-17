import { Schema } from "effect"

export const ServiceState = Schema.Literals(["waiting", "starting", "ready", "crashed", "done", "failed", "stopped"])
export type ServiceState = typeof ServiceState.Type

export const ServiceStatus = Schema.Struct({
  kind: Schema.Literals(["http", "worker", "task", "infra"]),
  state: ServiceState,
  url: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  runId: Schema.optional(Schema.Number),
  run: Schema.optional(Schema.Number),
  shared: Schema.optional(Schema.Boolean),
  detail: Schema.optional(Schema.String)
})
export type ServiceStatus = typeof ServiceStatus.Type

export const WorktreeStatus = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  branch: Schema.String,
  root: Schema.String,
  services: Schema.Record(Schema.String, ServiceStatus)
})
export type WorktreeStatus = typeof WorktreeStatus.Type

export const Snapshot = Schema.Record(Schema.String, WorktreeStatus)
export type Snapshot = typeof Snapshot.Type

export const LogLine = Schema.Struct({
  worktree: Schema.String,
  service: Schema.String,
  runId: Schema.Number,
  seq: Schema.Number,
  at: Schema.Number,
  line: Schema.String
})
export type LogLine = typeof LogLine.Type

export const RunInfo = Schema.Struct({
  id: Schema.Number,
  worktree: Schema.String,
  service: Schema.String,
  n: Schema.Number,
  pid: Schema.Number,
  command: Schema.String,
  startedAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number)
})
export type RunInfo = typeof RunInfo.Type

export const RunLine = Schema.Struct({
  runId: Schema.Number,
  seq: Schema.Number,
  at: Schema.Number,
  line: Schema.String
})
export type RunLine = typeof RunLine.Type

export const EnvVar = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  sensitive: Schema.Boolean,
  source: Schema.String,
  replaced: Schema.optional(Schema.String),
  warning: Schema.optional(Schema.String)
})
export type EnvVar = typeof EnvVar.Type
