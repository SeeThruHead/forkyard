import { Metric } from "effect"

export const processStarts = Metric.counter("forkyard.process.starts", {
  description: "Processes started by forkyard, per worktree and service",
  incremental: true
})

export const processExits = Metric.counter("forkyard.process.exits", {
  description: "Supervised processes that exited, with exit code",
  incremental: true
})

export const restarts = Metric.counter("forkyard.service.restarts", {
  description: "Restarts of long-running services, crash or request",
  incremental: true
})

export const serviceReady = Metric.histogram("forkyard.service.ready_ms", {
  description: "Time from spawn to healthy for a service run",
  boundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]
})

export const envResolve = Metric.histogram("forkyard.env.resolve_ms", {
  description: "Time to resolve a service's env from all sources",
  boundaries: [10, 25, 50, 100, 250, 500, 1000, 2500]
})

export const infraStart = Metric.histogram("forkyard.infra.start_ms", {
  description: "Time to start an infrastructure instance",
  boundaries: [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]
})

export const worktreesRunning = Metric.gauge("forkyard.worktrees.running", {
  description: "Worktrees the daemon is running"
})

export const logLines = Metric.counter("forkyard.process.log_lines", {
  description: "Lines of process output captured",
  incremental: true
})
