import type { UsageMap } from "../src/Model.ts"

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
