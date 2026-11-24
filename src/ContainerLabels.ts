import type { DaemonId } from "./Ids.ts"
import { isShell } from "./platform/Os.ts"
import type { Command, Run } from "./Stack.ts"

export const daemonLabel = "forkyard.daemon"

export const runLabel = "forkyard.run"

export const isDockerRun = (run: Run): run is Command => {
  if (isShell(run)) return false
  if (run.command.split("/").at(-1) !== "docker") return false
  return run.args[0] === "run"
}

export const labelledContainer = (run: Run, labels: { readonly daemon: DaemonId; readonly run: string }): Run => {
  if (!isDockerRun(run)) return run
  return {
    ...run,
    args: ["run", "--label", `${daemonLabel}=${labels.daemon}`, "--label", `${runLabel}=${labels.run}`, ...run.args.slice(1)]
  }
}
