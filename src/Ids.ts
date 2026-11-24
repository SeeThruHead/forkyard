import { Hash, Schema } from "effect"

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const slug = Schema.String.pipe(Schema.check(Schema.isPattern(slugPattern), Schema.isMaxLength(63)))

const positiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))

const toSlug = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 63)

export const ProjectName = slug.pipe(Schema.brand("ProjectName"))
export type ProjectName = typeof ProjectName.Type

export const BranchSlug = slug.pipe(Schema.brand("BranchSlug"))
export type BranchSlug = typeof BranchSlug.Type

export const branchSlug = (branch: string) => BranchSlug.makeOption(toSlug(branch))

export const ServiceName = slug.pipe(Schema.brand("ServiceName"))
export type ServiceName = typeof ServiceName.Type

export const InfraName = slug.pipe(Schema.brand("InfraName"))
export type InfraName = typeof InfraName.Type

export const WorktreeId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  Schema.brand("WorktreeId")
)
export type WorktreeId = typeof WorktreeId.Type

export const worktreeId = (branch: BranchSlug, project: ProjectName): WorktreeId => WorktreeId.make(`${branch}.${project}`)

export const Pid = positiveInt.pipe(Schema.brand("Pid"))
export type Pid = typeof Pid.Type

export const DaemonId = Schema.String.pipe(Schema.brand("DaemonId"))
export type DaemonId = typeof DaemonId.Type

export const RunId = positiveInt.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

export const RunNumber = positiveInt.pipe(Schema.brand("RunNumber"))
export type RunNumber = typeof RunNumber.Type

export const Port = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })), Schema.brand("Port"))
export type Port = typeof Port.Type

export const DatabaseName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z_][a-z0-9_]*$/), Schema.isMaxLength(63)),
  Schema.brand("DatabaseName")
)
export type DatabaseName = typeof DatabaseName.Type

const identifierLimit = 63

const keptPrefix = 54

const normalized = (parts: ReadonlyArray<string>) =>
  parts
    .join("_")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replace(/^(?=[0-9])/, "_")

const withinLimit = (name: string) =>
  name.length <= identifierLimit ? name : `${name.slice(0, keptPrefix)}_${(Hash.string(name) >>> 0).toString(36).padStart(7, "0")}`

export const databaseName = (...parts: ReadonlyArray<string>): DatabaseName => DatabaseName.make(withinLimit(normalized(parts)))

export const templateDatabaseName = (project: string): DatabaseName => DatabaseName.make(withinLimit(`${normalized([project])}__golden`))

export const AbsolutePath = Schema.String.pipe(Schema.check(Schema.isPattern(/^\//)), Schema.brand("AbsolutePath"))
export type AbsolutePath = typeof AbsolutePath.Type

export const ProcessOwner = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(forkyard|infra:[a-z0-9.-]+|[a-z0-9-]+\.[a-z0-9-]+)$/)),
  Schema.brand("ProcessOwner")
)
export type ProcessOwner = typeof ProcessOwner.Type

export const ownerOfWorktree = (id: WorktreeId): ProcessOwner => ProcessOwner.make(id)

export const ownerOfInfra = (instance: string): ProcessOwner => ProcessOwner.make(`infra:${instance}`)

export const daemonOwner: ProcessOwner = ProcessOwner.make("forkyard")
