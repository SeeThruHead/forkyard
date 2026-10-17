import { execFile } from "node:child_process"
import { useEffect, useState } from "react"

export type Usage = { readonly cpu: number; readonly rssKb: number }

type Row = { readonly pid: number; readonly ppid: number; readonly cpu: number; readonly rssKb: number }

const parseRows = (output: string): ReadonlyArray<Row> =>
  output
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => parts.length === 4 && parts.every((part) => !Number.isNaN(part)))
    .map(([pid, ppid, cpu, rssKb]) => ({ pid: pid!, ppid: ppid!, cpu: cpu!, rssKb: rssKb! }))

const childrenOf = (rows: ReadonlyArray<Row>) =>
  rows.reduce<Readonly<Record<number, ReadonlyArray<Row>>>>((all, row) => ({ ...all, [row.ppid]: [...(all[row.ppid] ?? []), row] }), {})

const treeUsage = (row: Row, children: Readonly<Record<number, ReadonlyArray<Row>>>): Usage =>
  (children[row.pid] ?? []).reduce(
    (total, child) => {
      const usage = treeUsage(child, children)
      return { cpu: total.cpu + usage.cpu, rssKb: total.rssKb + usage.rssKb }
    },
    { cpu: row.cpu, rssKb: row.rssKb }
  )

const usageByPid = (rows: ReadonlyArray<Row>, pids: ReadonlyArray<number>): Readonly<Record<number, Usage>> => {
  const children = childrenOf(rows)
  const byPid = Object.fromEntries(rows.map((row) => [row.pid, row]))
  return Object.fromEntries(pids.flatMap((pid) => (byPid[pid] ? [[pid, treeUsage(byPid[pid], children)]] : [])))
}

const readProcesses = () =>
  new Promise<string>((resolve) => execFile("ps", ["-A", "-o", "pid=,ppid=,%cpu=,rss="], (error, stdout) => resolve(error ? "" : stdout)))

export const useUsage = (pids: ReadonlyArray<number>) => {
  const [usage, setUsage] = useState<Readonly<Record<number, Usage>>>({})
  const key = [...pids].sort((a, b) => a - b).join(",")

  useEffect(() => {
    const sample = () => void readProcesses().then((output) => setUsage(usageByPid(parseRows(output), pids)))
    sample()
    const timer = setInterval(sample, 2000)
    return () => clearInterval(timer)
  }, [key])

  return usage
}

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
