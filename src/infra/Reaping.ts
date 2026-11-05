export type Usage = { readonly tenant: string; readonly root: string; readonly lastUsed: number }

const unique = <A>(values: ReadonlyArray<A>) => [...new Set(values)]

const lastUsedOf = (usages: ReadonlyArray<Usage>, tenant: string) =>
  Math.max(...usages.filter((usage) => usage.tenant === tenant).map((usage) => usage.lastUsed))

export const reapable = (
  usages: ReadonlyArray<Usage>,
  live: ReadonlySet<string>,
  now: number,
  graceMillis: number
): ReadonlyArray<string> =>
  unique(usages.map((usage) => usage.tenant))
    .filter((tenant) => !live.has(tenant))
    .filter((tenant) => now - lastUsedOf(usages, tenant) > graceMillis)
