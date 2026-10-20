export type Usage = { readonly tenant: string; readonly root: string; readonly lastUsed: number }

const unique = <A>(values: ReadonlyArray<A>) => [...new Set(values)]

const latestFor = (usages: ReadonlyArray<Usage>, root: string) =>
  usages.filter((usage) => usage.root === root).toSorted((a, b) => b.lastUsed - a.lastUsed)[0]?.tenant

const lastUsedOf = (usages: ReadonlyArray<Usage>, tenant: string) =>
  Math.max(...usages.filter((usage) => usage.tenant === tenant).map((usage) => usage.lastUsed))

export const kept = (usages: ReadonlyArray<Usage>, existingRoots: ReadonlySet<string>): ReadonlySet<string> =>
  new Set(
    unique(usages.map((usage) => usage.root))
      .filter((root) => existingRoots.has(root))
      .flatMap((root) => [latestFor(usages, root)].filter((tenant) => tenant !== undefined))
  )

export const reapable = (
  usages: ReadonlyArray<Usage>,
  live: ReadonlySet<string>,
  existingRoots: ReadonlySet<string>,
  now: number,
  graceMillis: number
): ReadonlyArray<string> => {
  const keep = kept(usages, existingRoots)
  return unique(usages.map((usage) => usage.tenant))
    .filter((tenant) => !live.has(tenant))
    .filter((tenant) => !keep.has(tenant))
    .filter((tenant) => now - lastUsedOf(usages, tenant) > graceMillis)
}
