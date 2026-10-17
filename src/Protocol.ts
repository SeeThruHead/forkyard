import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { AbsolutePath, ProcessOwner, RunId, ServiceName, WorktreeId } from "./Ids.ts"
import { EnvVar, LogLine, RunInfo, RunLine, Snapshot } from "./Model.ts"

export class ForkyardError extends Schema.TaggedError<ForkyardError>()("ForkyardError", {
  message: Schema.String
}) {}

const InWorktree = { id: WorktreeId }

export class ForkyardRpcs extends RpcGroup.make(
  Rpc.make("Up", {
    payload: { root: AbsolutePath, branch: Schema.String, stackFile: Schema.optional(AbsolutePath) },
    success: Schema.Struct({ id: WorktreeId }),
    error: ForkyardError
  }),
  Rpc.make("Down", { payload: InWorktree }),
  Rpc.make("Status", { success: Snapshot, stream: true }),
  Rpc.make("Logs", { payload: InWorktree, success: LogLine, stream: true }),
  Rpc.make("Env", { payload: { ...InWorktree, service: ServiceName }, success: Schema.Array(EnvVar), error: ForkyardError }),
  Rpc.make("Restart", { payload: { ...InWorktree, service: ServiceName } }),
  Rpc.make("Runs", { payload: { owner: ProcessOwner, service: Schema.String }, success: Schema.Array(RunInfo) }),
  Rpc.make("RunLog", { payload: { runId: RunId }, success: RunLine, stream: true }),
  Rpc.make("Routes", { success: Schema.Record(Schema.String, Schema.Number) }),
  Rpc.make("Infra", { success: Schema.Array(Schema.String) })
) {}
