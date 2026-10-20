import { serviceUrl, type WorktreeView } from "../../src/Model.ts"

export const counts = (worktree: WorktreeView) => {
  const states = Object.values(worktree.services).map((view) => view.state._tag)
  return {
    total: states.length,
    settled: states.filter((state) => state === "Ready" || state === "Done").length,
    failed: states.filter((state) => state === "Failed").length,
    busy: states.filter((state) => ["Waiting", "Preparing", "Starting", "Restarting"].includes(state)).length
  }
}

export const healthOf = (worktree: WorktreeView) => {
  const { total, settled, failed, busy } = counts(worktree)
  if (failed > 0) return { state: "Failed", label: `${settled}/${total} · ${failed} failed` }
  if (busy > 0) return { state: "Starting", label: `${settled}/${total} · ${busy} starting` }
  return { state: "Ready", label: `${settled}/${total} ready` }
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
