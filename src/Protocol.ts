import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { EnvVar, LogLine, RunInfo, RunLine, Snapshot } from "./Model.ts"

export class ForkyardError extends Schema.TaggedError<ForkyardError>()("ForkyardError", {
  message: Schema.String
}) {}

const WorktreeRef = { id: Schema.String }

export class ForkyardRpcs extends RpcGroup.make(
  Rpc.make("Up", {
    payload: { root: Schema.String, branch: Schema.String, stackFile: Schema.optional(Schema.String) },
    success: Schema.Struct({ id: Schema.String }),
    error: ForkyardError
  }),
  Rpc.make("Down", { payload: WorktreeRef }),
  Rpc.make("Status", { success: Snapshot, stream: true }),
  Rpc.make("Logs", { payload: WorktreeRef, success: LogLine, stream: true }),
  Rpc.make("Env", { payload: { ...WorktreeRef, service: Schema.String }, success: Schema.Array(EnvVar), error: ForkyardError }),
  Rpc.make("Restart", { payload: { ...WorktreeRef, service: Schema.String } }),
  Rpc.make("Runs", { payload: { ...WorktreeRef, service: Schema.String }, success: Schema.Array(RunInfo) }),
  Rpc.make("RunLog", { payload: { runId: Schema.Number }, success: RunLine, stream: true }),
  Rpc.make("Routes", { success: Schema.Record(Schema.String, Schema.Number) }),
  Rpc.make("Infra", { success: Schema.Array(Schema.String) })
) {}
