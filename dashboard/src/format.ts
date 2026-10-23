import { serviceUrl, type WorktreeView } from "../../src/Model.ts"

export const counts = (worktree: WorktreeView) => {
  const views = Object.values(worktree.services)
  const awake = views.filter((view) => !view.asleep).map((view) => view.state._tag)
  return {
    total: views.length,
    asleep: views.length - awake.length,
    settled: awake.filter((state) => state === "Ready" || state === "Done").length,
    failed: awake.filter((state) => state === "Failed").length,
    busy: awake.filter((state) => ["Waiting", "Preparing", "Starting", "Restarting"].includes(state)).length
  }
}

const asleepNote = (asleep: number) => (asleep > 0 ? ` · ${asleep} asleep` : "")

export const healthOf = (worktree: WorktreeView) => {
  const { total, asleep, settled, failed, busy } = counts(worktree)
  if (failed > 0) return { state: "Failed", label: `${settled}/${total} · ${failed} failed` }
  if (busy > 0) return { state: "Starting", label: `${settled}/${total} · ${busy} starting${asleepNote(asleep)}` }
  if (asleep === total) return { state: "Asleep", label: `asleep · ${total} services` }
  return { state: "Ready", label: `${settled}/${total} ready${asleepNote(asleep)}` }
}

export const mainUrl = (worktree: WorktreeView) => {
  const http = Object.entries(worktree.services).flatMap(([name, view]) => {
    const url = serviceUrl(view)
    return url ? [[name, url] as const] : []
  })
  return (http.find(([name]) => ["portal", "web", "shop", "app", "console", "api"].includes(name)) ?? http[0])?.[1]
}

export const worktreeOrder = (a: WorktreeView, b: WorktreeView) => {
  if (a.project !== b.project) return a.project.localeCompare(b.project)
  if (a.branch === "main") return -1
  if (b.branch === "main") return 1
  return a.branch.localeCompare(b.branch)
}

const palette = ["#6aa9ff", "#c49bff", "#45c6bd", "#f2c14e", "#5fd38d", "#ff9e64", "#7dcfff", "#e0af68", "#bb9af7", "#9ece6a"]

export const keyColor = (key: string) => palette[[...key].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 7) % palette.length]
