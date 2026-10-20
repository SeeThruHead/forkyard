import type { ServiceNode } from "./Stack.ts"

const isTask = (service: ServiceNode) => service.lifecycle._tag === "RunOnce"

const growsInto = (local: ReadonlySet<string>) => (service: ServiceNode) => {
  if (isTask(service)) return false
  if (service.calls.some((callee) => local.has(callee))) return true
  return service.uses.some((infra) => local.has(infra))
}

const consumedBy = (services: ReadonlyArray<ServiceNode>, local: ReadonlySet<string>) =>
  services.filter((service) => !isTask(service) && local.has(service.name)).flatMap((service) => service.consumes)

const settle = (services: ReadonlyArray<ServiceNode>, local: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set([...local, ...services.filter(growsInto(local)).map((service) => service.name), ...consumedBy(services, local)])
  if (next.size === local.size) return local
  return settle(services, next)
}

const neededBy = (services: ReadonlyArray<ServiceNode>, local: ReadonlySet<string>, task: ServiceNode) =>
  services.some((service) => local.has(service.name) && service.after.includes(task.name))

const runsHere = (services: ReadonlyArray<ServiceNode>, local: ReadonlySet<string>, common: ReadonlySet<string>) => (task: ServiceNode) => {
  if (local.has(task.name)) return false
  if (!neededBy(services, local, task)) return false
  return task.uses.filter((infra) => !common.has(infra)).every((infra) => local.has(infra))
}

const withTasks = (services: ReadonlyArray<ServiceNode>, local: ReadonlySet<string>, common: ReadonlySet<string>): ReadonlySet<string> => {
  const tasks = services.filter(isTask).filter(runsHere(services, local, common))
  if (tasks.length === 0) return local
  return withTasks(services, new Set([...local, ...tasks.map((task) => task.name)]), common)
}

export const localNames = (
  services: ReadonlyArray<ServiceNode>,
  seeds: ReadonlySet<string>,
  common: ReadonlySet<string> = new Set()
): ReadonlySet<string> => {
  const taskNames = new Set<string>(services.filter(isTask).map((task) => task.name))
  const placeable = new Set([...seeds].filter((name) => !taskNames.has(name) && !common.has(name)))
  return withTasks(services, settle(services, placeable), common)
}

const dependenciesOf = (services: ReadonlyArray<ServiceNode>, names: ReadonlySet<string>) =>
  services.filter((service) => names.has(service.name)).flatMap((service) => service.after)

export const demandedNames = (services: ReadonlyArray<ServiceNode>, roots: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set([...roots, ...dependenciesOf(services, roots)])
  if (next.size === roots.size) return roots
  return demandedNames(services, next)
}
